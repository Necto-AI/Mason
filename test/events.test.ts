/**
 * The generic event door: one path, one envelope, one signature, one fire.
 *
 * Two layers are pinned separately. The pure half — the signature and the envelope — is tested without a server, so a
 * version mason does not know, a field over its cap and a body that is not an object each have a verdict of their own.
 * The door itself is tested against a started server, because what matters there is only what a sender sees: the status,
 * the answer, and the one `app.hook` entry the delivery left behind. GitHub's route is tested in `github.test.ts`; this
 * file is the door that replaces the shape, not the path that predates it.
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
import { readEnvelope, verifySignature } from "../src/server/events.ts";
import { housePaths, type HousePaths } from "../src/server/house.ts";
import type { AgentRuntime, ResolvedModel } from "../src/server/runtime.ts";
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

const integrationsFile = {
	integrations: {
		telegram: { enabled: true, trigger: { hook: "workspace-check", secret: telegramSecret } },
		docs: { enabled: true, trigger: { hook: "morning-brief", secret: docsSecret } },
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

/** Every hook trigger in the durable transcript: one per fire pi-durable admitted. */
async function hookEntries(runtime: AgentRuntime): Promise<{ readonly text: string }[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return page.items
		.filter((entry) => entry.kind === HOOK_ENTRY_KIND)
		.map((entry) => {
			const content = entry.model?.[0]?.content;
			return { text: typeof content === "string" ? content : "" };
		});
}

/**
 * Waits until the transcript holds `count` hook entries. A fire is admitted at once but a busy conversation queues the
 * inputs behind the running turn, so the entries arrive when the run ends — and this is what the reader's history says.
 */
async function settledHookEntries(runtime: AgentRuntime, count: number): Promise<{ readonly text: string }[]> {
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
