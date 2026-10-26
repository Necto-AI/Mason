/**
 * The generic event door: one path, one envelope, one signature, one fire.
 *
 * Two layers are pinned separately. The pure half — the signature and the envelope — is tested without a server, so a
 * version mason does not know, a field over its cap and a body that is not an object each have a verdict of their own.
 * The door itself is tested against a started server, because what matters there is only what a sender sees: the status,
 * the answer, and the one `app.hook` entry the delivery left behind.
 *
 * The identity tests read the durable transcript rather than a counter, because that is where the dedupe lives: the same
 * `id` is the same request id, and pi-durable never admits one twice — including after a restart, which is the only
 * reason a sender can safely retry.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { RunningServer } from "../src/server/main.ts";
import { startServer } from "../src/server/main.ts";
import { readCommand, readEnvelope, verifySignature } from "../src/server/events.ts";
import { housePaths, type HousePaths } from "../src/server/house.ts";
import { EVENT_BODY_MAX_BYTES } from "../src/server/limits.ts";
import type { AgentRuntime, ResolvedModel } from "../src/server/runtime.ts";
import { isBusy, queuedSubmissions } from "../src/server/status.ts";
import { HOOK_ENTRY_KIND } from "../src/shared/contract.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporaryHome(): Promise<HousePaths> {
	const directory = await mkdtemp(join(tmpdir(), "mason-events-"));
	directories.add(directory);
	const paths = housePaths(join(directory, "house"));
	await mkdir(paths.home, { recursive: true, mode: 0o700 });
	return paths;
}

/** Two integrations with their own secrets, one switched off, and one with no trigger face at all. */
const telegramSecret = "0f".repeat(32);
const docsSecret = "1e".repeat(32);
const pagerSecret = "3b".repeat(32);

const integrationsFile = {
	integrations: {
		telegram: {
			enabled: true,
			trigger: { hook: "workspace-check", secret: telegramSecret },
			commands: ["stop", "compact", "clear", "status"],
		},
		docs: { enabled: true, trigger: { hook: "morning-brief", secret: docsSecret } },
		// A second door that declares one command, so the key's integration half is tested as well as the id half.
		pager: { enabled: true, trigger: { hook: "workspace-check", secret: pagerSecret }, commands: ["stop"] },
		// Disabled, and its hook deliberately does not exist: a switched-off door is not a reason to refuse the boot.
		off: { enabled: false, trigger: { hook: "no-such-hook", secret: "2a".repeat(32) } },
		"no-trigger": { enabled: true },
	},
};

async function writeIntegrations(paths: HousePaths, file: unknown = integrationsFile): Promise<void> {
	await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
	await writeFile(paths.integrations, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
}

/** A provider with enough scripted answers for the fires a test starts; without one every run ends in a faux error. */
function fauxAccess(count = 16): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: count }, (_, index) => fauxAssistantMessage(fauxText(`noted ${index}`))));
	return { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
}

interface EventsServer {
	readonly base: string;
	readonly token: string;
	readonly server: RunningServer;
	close(): Promise<void>;
}

/** A running server over `paths`. `storage: "memory"` is the default; the restart test keeps the real SQLite file. */
async function serve(paths: HousePaths, options: { storage?: "memory"; token?: string } = {}): Promise<EventsServer> {
	const directory = dirname(paths.home);
	const server = await startServer({
		port: 0,
		hostname: "127.0.0.1",
		...(options.storage === undefined ? {} : { storage: options.storage }),
		dataDir: join(directory, "data"),
		workspaceDir: join(directory, "workspace"),
		houseHome: paths.home,
		modelAccess: fauxAccess(),
		onReport: () => {},
	});
	const paired = options.token ?? server.pairingToken;
	assert.ok(paired, "a fresh home mints one token, which is what pairs this test");
	return {
		base: `http://127.0.0.1:${server.port}`,
		token: paired,
		server,
		close: () => server.close(),
	};
}

function signature(secret: string, body: string): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { v: 1, id: "issue-1421-opened", kind: "issue.opened", payload: "Ilya opened issue #1421", ...overrides };
}

/** A command in the door's second kind: the word a person typed after the slash, and nothing else. */
function command(payload: string, id = "chat-1"): Record<string, unknown> {
	return { v: 1, id, kind: "command", payload };
}

/** Every command the durable log was told about: one entry per claim, which is what its dedupe is read from. */
async function commandEntries(runtime: AgentRuntime): Promise<Record<string, unknown>[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return page.items
		.filter((entry) => entry.kind === "app.command")
		.map((entry) =>
			typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)
				? (entry.data as Record<string, unknown>)
				: {},
		);
}

/** A delivery with the right header unless one is passed; `null` sends no signature at all. */
function deliver(
	server: EventsServer,
	name: string,
	body: string,
	header: string | null = signature(telegramSecret, body),
): Promise<Response> {
	return fetch(`${server.base}/api/events/${name}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(header === null ? {} : { "x-mason-signature": header }),
		},
		body,
	});
}

/** Every hook trigger in the durable transcript: one per fire pi-durable admitted, with what it carries. */
async function hookEntries(
	runtime: AgentRuntime,
): Promise<{ readonly text: string; readonly data: Record<string, unknown> }[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return page.items
		.filter((entry) => entry.kind === HOOK_ENTRY_KIND)
		.map((entry) => {
			const content = entry.model?.[0]?.content;
			const data = entry.data;
			return {
				text: typeof content === "string" ? content : "",
				data:
					typeof data === "object" && data !== null && !Array.isArray(data)
						? (data as Record<string, unknown>)
						: {},
			};
		});
}

/**
 * Waits until the transcript holds `count` hook entries. A fire is admitted at once but a busy conversation queues the
 * inputs behind the running turn, so the entries arrive when the run ends — and this is what the reader's history says.
 */
async function settledHookEntries(
	runtime: AgentRuntime,
	count: number,
): Promise<{ readonly text: string; readonly data: Record<string, unknown> }[]> {
	const deadline = Date.now() + 5_000;
	let entries = await hookEntries(runtime);
	while (entries.length < count && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		entries = await hookEntries(runtime);
	}
	assert.equal(entries.length, count, "every admitted fire is one entry in the transcript");
	return entries;
}

describe("the event signature", () => {
	it("accepts the hmac over the raw bytes", () => {
		const raw = Buffer.from(JSON.stringify(envelope()));
		assert.equal(verifySignature(telegramSecret, raw, signature(telegramSecret, raw.toString())), true);
	});

	it("refuses one changed byte, another secret, and a header that is not sha256=<32 bytes hex>", () => {
		const raw = Buffer.from(JSON.stringify(envelope()));
		const signed = signature(telegramSecret, raw.toString());
		assert.equal(verifySignature(telegramSecret, Buffer.from(raw.toString().replace("opened", "edited")), signed), false);
		assert.equal(verifySignature(docsSecret, raw, signed), false);
		assert.equal(verifySignature(telegramSecret, raw, undefined), false);
		assert.equal(verifySignature(telegramSecret, raw, "sha1=deadbeef"), false);
		assert.equal(verifySignature(telegramSecret, raw, "sha256=deadbeef"), false);
		assert.equal(verifySignature(telegramSecret, raw, "sha256=zz"), false);
	});
});

describe("the envelope", () => {
	function read(fields: unknown): ReturnType<typeof readEnvelope> {
		return readEnvelope(Buffer.from(typeof fields === "string" ? fields : JSON.stringify(fields)));
	}

	it("reads v1, and ignores keys it does not know", () => {
		const body = envelope({ at: "the sender's clock is not evidence", integration: "telegram" });
		assert.deepEqual(read(body), { v: 1, id: "issue-1421-opened", kind: "issue.opened", payload: "Ilya opened issue #1421" });
	});

	it("refuses a version mason does not know", () => {
		const result = read(envelope({ v: 2 }));
		assert.ok("error" in result);
		assert.match(result.error, /"v"/);
	});

	it("refuses a missing id, a missing kind, and a payload that is not a string", () => {
		for (const [body, field] of [
			[envelope({ id: undefined }), /"id"/],
			[envelope({ id: "" }), /"id"/],
			[envelope({ id: "x".repeat(201) }), /"id"/],
			[envelope({ kind: undefined }), /"kind"/],
			[envelope({ kind: "x".repeat(65) }), /"kind"/],
			[envelope({ payload: { title: "not a string" } }), /"payload"/],
		] as const) {
			const result = read(body);
			assert.ok("error" in result, `${JSON.stringify(body)} was accepted`);
			assert.match(result.error, field);
		}
	});

	it("refuses an id holding a control character, because the accept log prints it as one line", () => {
		for (const id of ["issue\n1421", "issue\r1421", "issue\u00001421", "issue\u007f1421"]) {
			const result = read(envelope({ id }));
			assert.ok("error" in result, `${JSON.stringify(id)} was accepted`);
			assert.match(result.error, /"id" must be one line/);
		}
	});

	it("accepts an id that is long but one line: dots, dashes, colons and slashes to the cap", () => {
		const punctuated = `${"a".repeat(176)}-issue:1421.opened/fix_2`;
		assert.equal(punctuated.length, 200, "the cap itself, not one over it");
		assert.deepEqual(read(envelope({ id: punctuated })), {
			v: 1,
			id: punctuated,
			kind: "issue.opened",
			payload: "Ilya opened issue #1421",
		});
		assert.deepEqual(read(envelope({ id: "x".repeat(200) })), {
			v: 1,
			id: "x".repeat(200),
			kind: "issue.opened",
			payload: "Ilya opened issue #1421",
		});
	});

	it("refuses a kind that is not a token: a newline, a space, a leading dot", () => {
		for (const kind of ["issue\nopened", "issue opened", ".issue.opened"]) {
			const result = read(envelope({ kind }));
			assert.ok("error" in result, `${JSON.stringify(kind)} was accepted`);
			assert.match(result.error, /"kind" must be a short token/);
		}
	});

	it("accepts a token kind such as issue.opened", () => {
		const result = read(envelope({ kind: "issue.opened" }));
		assert.deepEqual(result, { v: 1, id: "issue-1421-opened", kind: "issue.opened", payload: "Ilya opened issue #1421" });
	});

	it("refuses an over-long payload rather than truncating it", () => {
		const payload = "x".repeat(2_001);
		const result = read(envelope({ payload }));
		assert.ok("error" in result);
		assert.match(result.error, /"payload"/);
		assert.match(result.error, /refused rather than truncated/);
	});

	it("refuses a body that is not a JSON object", () => {
		for (const body of ["not json", "[]", '"a string"', "null"]) {
			const result = read(body);
			assert.ok("error" in result, `${body} was accepted`);
			assert.match(result.error, /JSON object|not JSON/);
		}
	});
});

describe("the command a payload names", () => {
	const all = ["stop", "compact", "clear", "status"];

	it("reads a declared word, and the argument only compact reads", () => {
		assert.deepEqual(readCommand("stop", all), { command: "stop", argument: undefined });
		assert.deepEqual(readCommand(" status ", all), { command: "status", argument: undefined });
		assert.deepEqual(readCommand("compact keep the pricing thread", all), {
			command: "compact",
			argument: "keep the pricing thread",
		});
		assert.deepEqual(readCommand("compact", all), { command: "compact", argument: undefined });
		// A trailing space is nobody's instruction: a chat client may send one, and an argument of nothing is no argument.
		assert.deepEqual(readCommand("compact   ", all), { command: "compact", argument: undefined });
	});

	it("leaves an undeclared word to the relay, rather than refusing it", () => {
		for (const payload of ["", "start", "stopp", "Stop", "status please"]) {
			const declared = payload === "status please" ? ["stop"] : all;
			assert.deepEqual(readCommand(payload, declared), { undeclared: true }, payload);
		}
		// The set is closed: a name mason does not have is undeclared even if the file said otherwise.
		assert.deepEqual(readCommand("restart", ["stop", "restart"]), { undeclared: true });
	});

	it("holds a declared command to its shape, naming the rule it broke", () => {
		const withArgument = readCommand("status now", all);
		assert.ok("error" in withArgument);
		assert.match(withArgument.error, /"status" takes no argument/);

		const long = readCommand(`compact ${"x".repeat(201)}`, all);
		assert.ok("error" in long);
		assert.match(long.error, /"compact" takes at most 200 characters/);

		// Exactly the cap is a line, not a document: it is accepted, and it is the argument as typed.
		assert.deepEqual(readCommand(`compact ${"x".repeat(200)}`, all), {
			command: "compact",
			argument: "x".repeat(200),
		});
	});
});

describe("the event door", () => {
	it("fires the named hook with the payload fenced, and leaves one entry in the transcript", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			const body = JSON.stringify(envelope({ payload: "Ilya opened issue #1421: the picker forgets the last name." }));
			const answer = await deliver(server, "telegram", body);
			assert.equal(answer.status, 202);
			const { submissionId } = (await answer.json()) as { submissionId?: unknown };
			assert.equal(typeof submissionId, "number", "a delivery is one admitted submission");

			const entries = await hookEntries(server.server.runtime);
			assert.equal(entries.length, 1, "one delivery is one fire");
			const text = entries[0]?.text ?? "";
			assert.match(text, /\[begin untrusted payload/, "the payload is fenced as data, not spliced in as instructions");
			assert.ok(text.includes("Ilya opened issue #1421"), "the sender's words reach the model");
			assert.match(text, /\[end untrusted payload\]/);
		} finally {
			await server.close();
		}
	});

	it("refuses a tampered body, another integration's secret and a missing header with one bare 401", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			const body = JSON.stringify(envelope());
			const tampered = JSON.stringify(envelope({ payload: "something else entirely" }));
			for (const [what, answer] of [
				["a changed body", await deliver(server, "telegram", tampered, signature(telegramSecret, body))],
				["another integration's secret", await deliver(server, "telegram", body, signature(docsSecret, body))],
				["no header", await deliver(server, "telegram", body, null)],
			] as const) {
				assert.equal(answer.status, 401, what);
				assert.deepEqual(await answer.json(), { error: "unauthorized" }, `${what} says nothing about which half failed`);
			}
			assert.equal((await hookEntries(server.server.runtime)).length, 0, "nothing was parsed into a fire");
		} finally {
			await server.close();
		}
	});

	it("refuses a bad envelope with a 400 naming the field, and fires nothing", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			for (const [label, body, field] of [
				["v2", JSON.stringify(envelope({ v: 2 })), /"v"/],
				["no id", JSON.stringify(envelope({ id: undefined })), /"id"/],
				["an id with a newline", JSON.stringify(envelope({ id: "issue\n1421" })), /"id" must be one line/],
				["over-long payload", JSON.stringify(envelope({ payload: "x".repeat(2_001) })), /"payload"/],
				["not an object", "[]", /JSON object/],
			] as const) {
				const answer = await deliver(server, "telegram", body);
				assert.equal(answer.status, 400, label);
				const { error } = (await answer.json()) as { error?: unknown };
				if (typeof error !== "string") assert.fail(`${label}: the refusal does not say what is wrong`);
				assert.match(error, field, label);
			}
			assert.equal((await hookEntries(server.server.runtime)).length, 0, "a refused envelope is not a fire");
		} finally {
			await server.close();
		}
	});

	it("makes the same id the same fire, before and after a restart", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const body = JSON.stringify(envelope({ id: "issue-1421-opened" }));

		const first = await serve(paths);
		try {
			assert.equal((await deliver(first, "telegram", body)).status, 202);
			assert.equal((await deliver(first, "telegram", body)).status, 202, "a redelivery is acknowledged, not refused");
			assert.equal((await hookEntries(first.server.runtime)).length, 1, "the durable log admitted it once");
		} finally {
			await first.close();
		}

		// The same home and the same database: a redelivery days later is still the event the first delivery was.
		const second = await serve(paths, { token: first.token });
		try {
			assert.equal((await deliver(second, "telegram", body)).status, 202);
			assert.equal((await hookEntries(second.server.runtime)).length, 1, "a restart does not forget a request id");
		} finally {
			await second.close();
		}
	});

	it("keys a fire by integration and id, so two integrations on one hook are two doors", async () => {
		const paths = await temporaryHome();
		// Both point at one hook, which is what the spec allows: `id` is unique within an integration, not across a hook.
		await writeIntegrations(paths, {
			integrations: {
				telegram: { enabled: true, trigger: { hook: "workspace-check", secret: telegramSecret } },
				pager: { enabled: true, trigger: { hook: "workspace-check", secret: pagerSecret } },
			},
		});
		const server = await serve(paths);
		try {
			const body = JSON.stringify(envelope({ id: "1" }));
			assert.equal((await deliver(server, "telegram", body)).status, 202);
			assert.equal((await deliver(server, "pager", body, signature(pagerSecret, body))).status, 202);
			assert.equal((await settledHookEntries(server.server.runtime, 2)).length, 2, "two senders, two events");

			// The same integration naming the same delivery again is still that one fire.
			assert.equal((await deliver(server, "telegram", body)).status, 202, "a redelivery is acknowledged, not refused");
			assert.equal((await hookEntries(server.server.runtime)).length, 2, "and adds nothing to the transcript");
		} finally {
			await server.close();
		}
	});

	it("carries the sender's kind into the entry and the prompt", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			const body = JSON.stringify(envelope({ kind: "issue.opened", payload: "Ilya opened issue #1421" }));
			assert.equal((await deliver(server, "telegram", body)).status, 202);
			const [entry] = await settledHookEntries(server.server.runtime, 1);
			assert.equal(entry?.data.kind, "issue.opened", "the transcript says what happened, for the reader and for the log");
			assert.match(entry?.text ?? "", /Event: issue\.opened/, "and the model is told without parsing the prose");
		} finally {
			await server.close();
		}
	});

	it("answers 405 to a verb that is not POST on a door that exists", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			const answer = await fetch(`${server.base}/api/events/telegram`);
			assert.equal(answer.status, 405, "the door is there, so the verb is the sender's mistake to see");
			assert.deepEqual(await answer.json(), { error: "method not allowed" });
			assert.equal((await hookEntries(server.server.runtime)).length, 0, "a non-POST fires nothing");
		} finally {
			await server.close();
		}
	});

	it("refuses a body over the cap with a 413 before the signature is read", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			// No signature at all: the cap is checked first, so this is a 413 and not the 401 a bare body would get.
			const body = "x".repeat(EVENT_BODY_MAX_BYTES + 1);
			const answer = await deliver(server, "telegram", body, null);
			assert.equal(answer.status, 413);
			assert.deepEqual(await answer.json(), { error: "payload too large", maxBytes: EVENT_BODY_MAX_BYTES });
			assert.equal((await hookEntries(server.server.runtime)).length, 0, "an over-long body is dropped, never truncated");
		} finally {
			await server.close();
		}
	});

	it("re-reads the switch at boot: a disabled door is 404, and the same door fires once it is enabled", async () => {
		const paths = await temporaryHome();
		const file = (enabled: boolean) => ({
			integrations: { telegram: { enabled, trigger: { hook: "workspace-check", secret: telegramSecret } } },
		});
		const body = JSON.stringify(envelope({ id: "switched-on" }));

		await writeIntegrations(paths, file(false));
		const off = await serve(paths);
		try {
			assert.equal((await deliver(off, "telegram", body)).status, 404, "a disabled integration has no door");
			assert.equal((await hookEntries(off.server.runtime)).length, 0);
		} finally {
			await off.close();
		}

		// The switch is read once, at boot: enabling it is the restart, and the door answers on the far side of one.
		await writeIntegrations(paths, file(true));
		const on = await serve(paths, { token: off.token });
		try {
			assert.equal((await deliver(on, "telegram", body)).status, 202, "the same path is a door after the restart");
			await settledHookEntries(on.server.runtime, 1);
		} finally {
			await on.close();
		}
	});

	it("answers 404 for an unknown, disabled or trigger-less integration, and for a malformed path", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			const body = JSON.stringify(envelope());
			for (const name of ["nobody", "off", "no-trigger", "telegram/", "telegram/extra"]) {
				const answer = await deliver(server, name, body);
				assert.equal(answer.status, 404, name);
				assert.equal(await answer.text(), "not found", `${name} answers exactly like a path that is not a door`);
			}
			assert.equal((await hookEntries(server.server.runtime)).length, 0, "a door that is not there fires nothing");
		} finally {
			await server.close();
		}
	});

	it("spends six deliveries a minute per integration, and the seventh is a 429", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			for (let index = 0; index < 6; index += 1) {
				const body = JSON.stringify(envelope({ id: `delivery-${index}` }));
				assert.equal((await deliver(server, "telegram", body)).status, 202, `delivery ${index}`);
			}
			// Another integration has its own budget: the first one's minute is not spent against it.
			const docsBody = JSON.stringify(envelope({ id: "docs-1" }));
			assert.equal((await deliver(server, "docs", docsBody, signature(docsSecret, docsBody))).status, 202);
			const body = JSON.stringify(envelope({ id: "delivery-7" }));
			const refused = await deliver(server, "telegram", body);
			assert.equal(refused.status, 429);
			assert.ok(Number(refused.headers.get("retry-after")) >= 1, "the refusal names the wait, so a sender retries");
			// The sixth was admitted and the seventh was not: the transcript is the count, not the limiter's word.
			await settledHookEntries(server.server.runtime, 7);
		} finally {
			await server.close();
		}
	});

	it("is a door without a token, and is not a way to read the server", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			const body = JSON.stringify(envelope());
			const answer = await fetch(`${server.base}/api/events/telegram`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-mason-signature": signature(telegramSecret, body) },
				body,
			});
			assert.equal(answer.status, 202, "the HMAC is the door; the sender holds no token");

			const status = await fetch(`${server.base}/api/status`);
			assert.equal(status.status, 401, "an event sender cannot read the transcript");
			const withToken = await fetch(`${server.base}/api/status`, { headers: { authorization: `Bearer ${server.token}` } });
			assert.equal(withToken.status, 200, "the reading door still answers its owner");
		} finally {
			await server.close();
		}
	});

	it("refuses a boot whose enabled trigger fires a hook this build does not define, naming both", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths, {
			integrations: {
				telegram: { enabled: true, trigger: { hook: "no-such-hook", secret: telegramSecret } },
			},
		});
		await assert.rejects(
			() => serve(paths),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				assert.ok(message.includes("telegram"), `the refusal names the integration: ${message}`);
				assert.ok(message.includes("no-such-hook"), `the refusal names the hook: ${message}`);
				return true;
			},
		);
	});
});

/**
 * A running server whose first turn cannot finish until `release()`, with the turn already started. A command posted now
 * is genuinely posted into a running conversation, which is the only way to see whether it waits for the turn or acts on
 * it while the turn is still running.
 */
async function heldTurn(paths: HousePaths): Promise<{ server: RunningServer; base: string; release: () => void }> {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		async () => {
			await held;
			return fauxAssistantMessage(fauxText("the answer to the message you wrote"));
		},
	]);
	const directory = dirname(paths.home);
	const server = await startServer({
		port: 0,
		hostname: "127.0.0.1",
		storage: "memory",
		dataDir: join(directory, "data"),
		workspaceDir: join(directory, "workspace"),
		houseHome: paths.home,
		modelAccess: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true },
		onReport: () => {},
	});
	const conversation = await server.runtime.conversation();
	await conversation.submit({ type: "input", content: "think about it for a while" }, BACKGROUND_CONTEXT);
	const deadline = Date.now() + 5_000;
	while (!isBusy(await server.runtime.viewSnapshot(BACKGROUND_CONTEXT))) {
		assert.ok(Date.now() < deadline, "the turn started, so the command has something to act on");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return { server, base: `http://127.0.0.1:${server.port}`, release };
}

describe("a command at the door", () => {
	it("runs a declared command and answers the one line a chat reads", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			const stopped = await deliver(server, "telegram", JSON.stringify(command("stop")));
			assert.equal(stopped.status, 200);
			assert.deepEqual(await stopped.json(), { handled: true, reply: "stopped" });

			// A status changes nothing and answers from the view this boot derives, so the line is the live one.
			const status = await deliver(server, "telegram", JSON.stringify(command("status", "chat-2")));
			assert.equal(status.status, 200);
			const { handled, reply } = (await status.json()) as { handled?: unknown; reply?: unknown };
			assert.equal(handled, true);
			assert.match(String(reply), /^idle: nothing queued; no integration connected; nothing unreachable since boot$/);

			// Neither of them is a turn: a command that fired a hook would leave an entry, and a chat is not a wake-up.
			assert.equal((await hookEntries(server.server.runtime)).length, 0);
		} finally {
			await server.close();
		}
	});

	it("still stops a turn after six messages have spent the integration's minute", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			for (let index = 0; index < 6; index += 1) {
				const body = JSON.stringify(envelope({ id: `burst-${index}` }));
				assert.equal((await deliver(server, "telegram", body)).status, 202, `message ${index}`);
			}
			// The whole point: the six messages that just spent the minute are the ones whose turn a person now wants to
			// stop, so a refusal here would be the door refusing to let somebody interrupt what it started.
			const stop = await deliver(server, "telegram", JSON.stringify(command("stop", "burst-7")));
			assert.equal(stop.status, 200);
			assert.deepEqual(await stop.json(), { handled: true, reply: "stopped" });
		} finally {
			await server.close();
		}
	});

	it("spends six commands a minute on its own budget, leaving the message budget alone", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			for (let index = 0; index < 6; index += 1) {
				const body = JSON.stringify(command("stop", `stop-${index}`));
				assert.equal((await deliver(server, "telegram", body)).status, 200, `command ${index}`);
			}
			const refused = await deliver(server, "telegram", JSON.stringify(command("stop", "stop-7")));
			assert.equal(refused.status, 429, "a command is still a bill the sender controls");
			assert.ok(Number(refused.headers.get("retry-after")) >= 1);
			// And the other way round: commands are not a way to spend the integration's message budget either.
			const message = JSON.stringify(envelope({ id: "after-the-commands" }));
			assert.equal((await deliver(server, "telegram", message)).status, 202);
		} finally {
			await server.close();
		}
	});

	it("does not spend the command budget on words mason does nothing with", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			// The budget exists so that a spent minute can never refuse `/stop`, and a word mason ignores is not a bill: six
			// mistyped words and six malformed ones must not add up to the refusal the separate budget was there to prevent.
			for (let index = 0; index < 6; index += 1) {
				const undeclared = JSON.stringify(command("stopp", `stopp-${index}`));
				assert.equal((await deliver(server, "telegram", undeclared)).status, 200, `undeclared word ${index}`);
				const malformed = JSON.stringify(command("status now", `malformed-${index}`));
				assert.equal((await deliver(server, "telegram", malformed)).status, 400, `malformed command ${index}`);
			}
			const stop = await deliver(server, "telegram", JSON.stringify(command("stop", "after-the-noise")));
			assert.equal(stop.status, 200, "the minute is still whole for the command that acts");
			assert.deepEqual(await stop.json(), { handled: true, reply: "stopped" });
		} finally {
			await server.close();
		}
	});

	it("answers handled:false for a word the integration does not declare, and fires nothing", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			// `docs` declares no commands at all, so even a word mason knows is the sender's own business.
			for (const body of [command("stop", "chat-1"), command("start", "chat-2"), command("stopp", "chat-3")]) {
				const answer = await deliver(server, "docs", JSON.stringify(body), signature(docsSecret, JSON.stringify(body)));
				assert.equal(answer.status, 200, JSON.stringify(body));
				assert.deepEqual(await answer.json(), { handled: false }, "the relay is told to send the message it has");
			}
			assert.equal((await hookEntries(server.server.runtime)).length, 0);
		} finally {
			await server.close();
		}
	});

	it("refuses a malformed command with a 400 naming the rule, and a bad signature before it is read", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			const body = JSON.stringify(command("status now"));
			const malformed = await deliver(server, "telegram", body);
			assert.equal(malformed.status, 400);
			const { error } = (await malformed.json()) as { error?: unknown };
			assert.match(String(error), /"status" takes no argument/);

			// The signature is the door: a body the door would refuse with a `400` is a `401` when the sender did not sign
			// it, because nothing is parsed until the bytes are the sender's.
			const unsigned = await deliver(server, "telegram", body, signature(docsSecret, body));
			assert.equal(unsigned.status, 401);
			assert.deepEqual(await unsigned.json(), { error: "unauthorized" });
			assert.equal((await hookEntries(server.server.runtime)).length, 0);
		} finally {
			await server.close();
		}
	});

	it("admits one command per id, so a redelivery answers rather than acting twice", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const server = await serve(paths);
		try {
			const body = JSON.stringify(command("stop", "chat-7"));
			const first = await deliver(server, "telegram", body);
			assert.equal(first.status, 200);
			assert.deepEqual(await first.json(), { handled: true, reply: "stopped" });
			// The redelivery finds the claim: nothing ran, and the answer is empty rather than a second "stopped" for an act
			// that did not happen. The relay suppresses an empty reply, so the chat says nothing either.
			const again = await deliver(server, "telegram", body);
			assert.equal(again.status, 200);
			assert.deepEqual(await again.json(), { handled: true, reply: "" });
			assert.deepEqual(await commandEntries(server.server.runtime), [{ command: "stop" }], "one claim for two deliveries");
			// The same id at another door is another command: an id is unique within its integration, not across them.
			const elsewhere = JSON.stringify(command("stop", "chat-7"));
			const other = await deliver(server, "pager", elsewhere, signature(pagerSecret, elsewhere));
			assert.equal(other.status, 200);
			assert.deepEqual(await other.json(), { handled: true, reply: "stopped" });
			assert.equal((await commandEntries(server.server.runtime)).length, 2);
		} finally {
			await server.close();
		}
	});

	it("stops a turn that is running, because a command is not queued behind it", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		// A turn that cannot finish until the test says so: `/stop` is then genuinely posted into a running conversation.
		const turn = await heldTurn(paths);
		try {
			const body = JSON.stringify(command("stop", "while-running"));
			const stopped = fetch(`${turn.base}/api/events/telegram`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-mason-signature": signature(telegramSecret, body) },
				body,
			});
			// The door waits for the conversation to be idle again, so the turn is let go once the abort is in flight.
			// (Removed in the next commit: the abort is the thing being measured.)
			turn.release();
			const answer = await stopped;
			assert.equal(answer.status, 200);
			assert.deepEqual(await answer.json(), { handled: true, reply: "stopped" });
			assert.equal(isBusy(await turn.server.runtime.viewSnapshot(BACKGROUND_CONTEXT)), false, "the turn is over");
		} finally {
			turn.release();
			await turn.server.close();
		}
	});

	it("says a clear is queued behind the running turn, rather than that it happened", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths);
		const turn = await heldTurn(paths);
		try {
			const body = JSON.stringify(command("clear", "clear-while-running"));
			const cleared = await fetch(`${turn.base}/api/events/telegram`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-mason-signature": signature(telegramSecret, body) },
				body,
			});
			// A reset is a write the log queues behind the turn, so on a busy conversation it lands later. The answer says
			// that, and the view says it too: the turn is still the one running, and the reset is the one thing waiting.
			assert.equal(cleared.status, 200);
			assert.deepEqual(await cleared.json(), { handled: true, reply: "clearing after this turn" });
			const view = await turn.server.runtime.viewSnapshot(BACKGROUND_CONTEXT);
			assert.equal(isBusy(view), true, "the turn the clear is queued behind is still running");
			assert.equal(queuedSubmissions(view), 1, "and the reset is what is waiting behind it");
		} finally {
			turn.release();
			await turn.server.close();
		}
	});

	it("refuses a boot whose integration declares a command mason does not have, naming the set", async () => {
		const paths = await temporaryHome();
		await writeIntegrations(paths, {
			integrations: {
				telegram: {
					enabled: true,
					trigger: { hook: "workspace-check", secret: telegramSecret },
					commands: ["stop", "stopp"],
				},
			},
		});
		await assert.rejects(
			() => serve(paths),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				assert.ok(message.includes(paths.integrations), `the refusal names the file: ${message}`);
				assert.match(message, /"stopp"/);
				assert.match(message, /stop, compact, clear, status/, "the refusal names the whole set, so the fix is one line");
				return true;
			},
		);
	});
});
