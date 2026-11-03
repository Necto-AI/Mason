/**
 * The operator panel, end to end: one server, one faux provider, and the HTTP state a granted device is sent.
 *
 * This replaces the console's wire test (`chord-e2e.test.ts`) rather than sitting beside it: the conversation is no
 * longer served to a browser over a socket (#103), so what a browser can see is `GET /api/admin/state` and what it can
 * do is the writes beside it. The assertions are the ones that were about the agent — the projection, the queue, the
 * grants — retargeted at the only remaining door.
 *
 * A submission is made through the durable conversation, the way a connector's admission makes one: the panel is a
 * control plane and cannot speak, which is the point of the cutover.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ConversationView } from "@earendil-works/pi-durable";
import { mintToken, readConfig } from "../src/server/auth.ts";
import { housePaths } from "../src/server/house.ts";
import { type RunningServer, startServer } from "../src/server/main.ts";
import { promptSectionKeys } from "../src/server/prompt.ts";
import { addPerson } from "../src/server/roster.ts";
import { RETRY_HOOK_ID } from "../src/server/run-retry.ts";
import type { ResolvedModel } from "../src/server/runtime.ts";
import { grantsOf, type OperatorGrant, type PanelState } from "../src/shared/admin.ts";
import { REPLY_TOOL } from "../src/shared/contract.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

function fauxAccess(contextWindow?: number): { access: ResolvedModel; faux: ReturnType<typeof fauxProvider> } {
	const faux = fauxProvider(contextWindow === undefined ? {} : { models: [{ id: "faux-1", contextWindow }] });
	const models = createModels();
	models.setProvider(faux.provider);
	return { access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true }, faux };
}

function toolCall(name: string, args: JsonObject, id: string) {
	return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

async function until<T>(
	what: string,
	read: () => Promise<T | undefined> | T | undefined,
	timeoutMs = 15_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

interface Panel {
	readonly server: RunningServer;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly token: string;
	readonly home: string;
	/** The raw committed view, watched server-side: the trace half the panel is sometimes refused. */
	readonly view: () => ConversationView | undefined;
	state(): Promise<PanelState>;
	/** A token minted for this home with the grants asked for. */
	granted(grants: readonly OperatorGrant[]): Promise<string>;
	submit(content: string, whenBusy?: "followUp" | "steer"): Promise<number>;
	withdraw(id: number): Promise<void>;
	call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: any }>;
	close(): Promise<void>;
}

async function openPanel(
	extra: {
		settings?: NonNullable<Parameters<typeof startServer>[0]>["settings"];
		contextWindow?: number;
		withRoster?: boolean;
	} = {},
): Promise<Panel> {
	const directory = await mkdtemp(join(tmpdir(), "mason-panel-"));
	directories.add(directory);
	const { access, faux } = fauxAccess(extra.contextWindow);
	// The agent's home is a temporary directory, never the real `~/.mason`.
	const houseHome = join(directory, "house");
	const previousHouseHome = process.env.MASON_HOME;
	process.env.MASON_HOME = houseHome;
	if (extra.withRoster === true) await addPerson(housePaths(houseHome), "Ilya");
	const server = await startServer({
		port: 0,
		hostname: "127.0.0.1",
		storage: "memory",
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		modelAccess: access,
		houseHome,
		...(extra.settings === undefined ? {} : { settings: extra.settings }),
		onReport: () => {},
	});
	const minted = server.pairingToken;
	assert.equal(typeof minted, "string", "a fresh home mints a token");
	const token = minted as string;
	const raw = await server.runtime.viewState(BACKGROUND_CONTEXT);
	let view: ConversationView | undefined;
	let current: PanelState | undefined;
	raw.subscribe((value) => {
		view = value;
	});
	const base = `http://127.0.0.1:${server.port}`;

	const call = async (method: string, path: string, body?: unknown, presented?: string) => {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${presented ?? token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await response.text();
		// Not every route answers JSON: an unknown path is the plain-text `404`, and a test may be pinning exactly that.
		let parsed: any;
		try {
			parsed = text === "" ? undefined : JSON.parse(text);
		} catch {
			parsed = text;
		}
		return { status: response.status, body: parsed };
	};

	const state = async (): Promise<PanelState> => {
		const answer = await call("GET", "/api/admin/state");
		assert.equal(answer.status, 200, JSON.stringify(answer.body));
		current = answer.body as PanelState;
		return current;
	};

	return {
		server,
		faux,
		token,
		home: houseHome,
		view: () => view,
		state,
		async granted(grants) {
			const minted = await mintToken(houseHome, `test-${grants.join("-")}`, grants);
			return minted.token;
		},
		async submit(content, whenBusy) {
			const conversation = await server.runtime.conversation();
			const submission = await conversation.submit(
				{ type: "input", content, ...(whenBusy === undefined ? {} : { whenBusy }) },
				BACKGROUND_CONTEXT,
			);
			return submission.id;
		},
		async withdraw(id) {
			const conversation = await server.runtime.conversation();
			const submission = await server.runtime.harness.submission(id as never, BACKGROUND_CONTEXT);
			if (submission === undefined) throw new Error(`no submission ${id} in ${conversation.id}`);
			await submission.abort(BACKGROUND_CONTEXT);
		},
		call,
		async close() {
			await raw.dispose();
			await server.close();
			if (previousHouseHome === undefined) delete process.env.MASON_HOME;
			else process.env.MASON_HOME = previousHouseHome;
		},
	};
}

function entries(view: ConversationView | undefined): readonly Record<string, unknown>[] {
	return [...(view?.entries ?? [])] as unknown as readonly Record<string, unknown>[];
}

function inboxItems(view: ConversationView | undefined): { id: number; mode: string }[] {
	return (view?.docs["pi.inbox"] as { items: { id: number; mode: string }[] } | undefined)?.items ?? [];
}

function messageText(entry: Record<string, unknown> | undefined): string {
	const message = (entry?.model as { content?: unknown }[] | undefined)?.[0];
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? "").join("");
	return "";
}

function live(view: ConversationView | undefined) {
	return view?.docs["pi.live"] as
		| {
				run?: { taskId: number };
				tools?: { callId: string; name: string; status: string }[];
		  }
		| undefined;
}

/** The prompt sections in effect: the prompt the next request is given, after replaying the `pi.system` entries. */
function renderedSections(view: ConversationView | undefined): Map<string, string> {
	const shown = new Map<string, string>();
	for (const entry of entries(view)) {
		for (const message of (entry.model as { role: string; sections?: Record<string, string | null> }[] | undefined) ??
			[]) {
			if (message.role !== "system" || message.sections === undefined) continue;
			for (const [key, value] of Object.entries(message.sections)) {
				if (value === null) shown.delete(key);
				else shown.set(key, value);
			}
		}
	}
	return shown;
}

function offeredTools(view: ConversationView | undefined): string[] {
	return getCurrentTools(entries(view).flatMap((entry) => (entry.model as never[]) ?? [])).map((tool) => tool.name);
}

function offeredDeclarations(view: ConversationView | undefined): string[] {
	return getCurrentTools(entries(view).flatMap((entry) => (entry.model as never[]) ?? [])).map((tool) =>
		JSON.stringify(tool),
	);
}

describe("the operator panel", () => {
	it("pairs a browser, then serves the panel and its first question", async () => {
		const panel = await openPanel();
		try {
			const base = `http://127.0.0.1:${panel.server.port}`;
			const paired = await fetch(`${base}/?token=${encodeURIComponent(panel.token)}`, { redirect: "manual" });
			assert.equal(paired.status, 302);
			assert.equal(paired.headers.get("location"), "/", "the token leaves the address bar");
			const cookie = (paired.headers.getSetCookie().join(";").split(";")[0] as string).trim();
			assert.match(cookie, /^mason_session=/);

			const withCookie = await fetch(`${base}/api/admin/state`, { headers: { cookie } });
			assert.equal(withCookie.status, 200, "the cookie is the browser's credential");
			const state = (await withCookie.json()) as PanelState;
			assert.deepEqual(state.session.grants, ["conversation", "admin", "approve"]);

			const page = await fetch(`${base}/admin`);
			assert.equal(page.status, 200);
			const html = await page.text();
			assert.match(html, /admin\.js/, "the panel's bundle is what the page loads");
			assert.match(html, /admin\.css/);
			const script = await fetch(`${base}/admin.js`);
			assert.equal(script.status, 200, "the bundle is served beside the page");

			// The console and its socket contract are gone: `/join` (the console's name picker) is not a route any more,
			// and the old conversation socket is closed at the upgrade (`test/auth.test.ts` pins that).
			assert.equal((await panel.call("GET", "/api/join")).status, 404, "there is no join screen left");
		} finally {
			await panel.close();
		}
	});

	it("hydrates the conversation, streams a run, and returns to idle", async () => {
		const panel = await openPanel();
		try {
			const initial = await panel.state();
			assert.deepEqual(initial.conversation?.transcript, []);
			assert.equal(initial.conversation?.status.runStatus, "idle");
			assert.equal(initial.conversation?.status.busy, false);
			assert.deepEqual(
				initial.conversation?.status.hooks.map((hook) => hook.id),
				["morning-brief", "retry-failed-run", "github-activity", "workspace-check", "team-chat"],
			);
			assert.deepEqual(initial.conversation?.status.model, { provider: "faux", modelId: "faux-1" });
			// The trace is not this device's: the key is absent, not empty.
			assert.equal("trace" in initial, false);

			panel.faux.setResponses([
				fauxAssistantMessage(
					[
						fauxText("Hello from the agent."),
						fauxToolCall(REPLY_TOOL, { message: "Hello from the agent." }, { id: "hello" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxText("Nothing else to report.")),
			]);

			await panel.submit("Hello");
			const answered = await until("the answer", async () => {
				const state = await panel.state();
				const row = state.conversation?.transcript.find((item) => item.kind === "delivered");
				return row === undefined ? undefined : state;
			});
			assert.deepEqual(
				answered.conversation?.transcript.map((item) => item.kind),
				["user", "delivered"],
			);
			assert.equal(
				(answered.conversation?.transcript[1] as { text?: string } | undefined)?.text,
				"Hello from the agent.",
			);
			await until("idle again", async () =>
				(await panel.state()).conversation?.status.busy === false ? true : undefined,
			);
			// The durable conversation is what a chassis turn leaves behind: the words, the reply's own entry, the
			// call's result, and the note that closes the turn.
			assert.deepEqual(
				entries(panel.view()).map((entry) => entry.kind),
				["pi.user", "pi.system", "pi.assistant", "app.reply", "pi.tool-result", "pi.assistant"],
			);
		} finally {
			await panel.close();
		}
	});

	it("shows a running tool round, queues and withdraws a follow-up", async () => {
		const panel = await openPanel();
		try {
			panel.faux.setResponses([
				toolCall("bash", { command: "sleep 1.5" }, "slow"),
				fauxAssistantMessage(
					[
						fauxText("Slow command finished."),
						fauxToolCall(REPLY_TOOL, { message: "Slow command finished." }, { id: "slow-done" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxText("Nothing else to report.")),
			]);

			await panel.submit("Run something slow.");
			await until("running tools", async () =>
				(await panel.state()).conversation?.status.runStatus === "running_tools" ? true : undefined,
			);
			const running = await until("a running tool slot", () =>
				live(panel.view())?.tools?.find((slot) => slot.status === "running"),
			);
			assert.equal(running.name, "bash");
			assert.deepEqual((await panel.state()).conversation?.status.runningTools, ["bash"]);

			const queued = await panel.submit("Then check the logs.", "followUp");
			const item = await until("the queued item", () =>
				inboxItems(panel.view()).find((entry) => entry.id === queued),
			);
			assert.equal(item.mode, "followUp");
			const steered = await panel.submit("Also watch stderr.", "steer");
			const steerItem = await until("the queued steer", () =>
				inboxItems(panel.view()).find((entry) => entry.id === steered),
			);
			assert.equal(steerItem.mode, "steer");
			// The queue is in the panel's state, with its boundary spelled the way the reader sees it.
			const waiting = await until("the queue in the state", async () => {
				const state = await panel.state();
				return (state.conversation?.queued.length ?? 0) >= 2 ? state.conversation?.queued : undefined;
			});
			assert.deepEqual(
				new Set(waiting?.map((row) => row.text)),
				new Set(["Then check the logs.", "Also watch stderr."]),
			);

			await panel.withdraw(queued);
			await panel.withdraw(steered);
			await until("both withdrawn", () =>
				inboxItems(panel.view()).some((entry) => entry.id === queued || entry.id === steered) ? undefined : true,
			);
			await until("the answer", () =>
				entries(panel.view()).some((entry) => messageText(entry) === "Slow command finished.") ? true : undefined,
			);
			await until("idle", async () =>
				(await panel.state()).conversation?.status.busy === false ? true : undefined,
			);
			assert.equal(
				entries(panel.view()).filter((entry) => entry.kind === "pi.user").length,
				1,
				"the withdrawn follow-up was never placed",
			);
			assert.deepEqual((await panel.state()).conversation?.queued, []);
		} finally {
			await panel.close();
		}
	});

	it("lets a steer cut into a running turn", async () => {
		const panel = await openPanel();
		try {
			let afterSteer: { content?: unknown }[] = [];
			panel.faux.setResponses([
				toolCall("bash", { command: "sleep 0.6" }, "slow"),
				(context) => {
					afterSteer = context.messages;
					return fauxAssistantMessage(fauxText("Watching stderr now."));
				},
			]);
			await panel.submit("Run something slow.");
			await until("running tools", async () =>
				(await panel.state()).conversation?.status.runStatus === "running_tools" ? true : undefined,
			);
			await panel.submit("Also watch stderr.", "steer");
			await until("the steered answer", () =>
				entries(panel.view()).some((entry) => messageText(entry) === "Watching stderr now.") ? true : undefined,
			);
			assert.match(
				afterSteer
					.map((message) => {
						const content = (message as { content?: unknown }).content;
						return typeof content === "string" ? content : JSON.stringify(content);
					})
					.join("\n"),
				/Also watch stderr\./,
				"the steer reached the turn that was already running",
			);
			await until("idle", async () =>
				(await panel.state()).conversation?.status.busy === false ? true : undefined,
			);
			assert.equal(inboxItems(panel.view()).length, 0, "the steer was placed, not left waiting");
		} finally {
			await panel.close();
		}
	});

	it("keeps a failed run's queue, and takes a waiting submission back", async () => {
		const previous = process.env.PDA_RUN_RETRY_ATTEMPTS;
		process.env.PDA_RUN_RETRY_ATTEMPTS = "0";
		const panel = await openPanel();
		try {
			panel.faux.setResponses([
				toolCall("bash", { command: "sleep 0.3" }, "brief"),
				fauxAssistantMessage(fauxText("Answering would need the provider."), {
					stopReason: "error",
					errorMessage: "usage limit reached",
				}),
			]);
			await panel.submit("Run a step, then hit the limit.");
			const queued = await panel.submit("When it works again, tell me.", "followUp");
			await until("the failed answer", () =>
				entries(panel.view()).some(
					(entry) =>
						entry.kind === "pi.assistant" &&
						(entry.model as { stopReason?: string }[] | undefined)?.[0]?.stopReason === "error",
				)
					? true
					: undefined,
			);
			await until("idle after the failure", async () =>
				(await panel.state()).conversation?.status.busy === false ? true : undefined,
			);
			assert.deepEqual(
				inboxItems(panel.view()).map((item) => ({ id: item.id, mode: item.mode })),
				[{ id: queued, mode: "followUp" }],
			);
			// The reader is told the turn died, in one coarse line, and the queue is still theirs to withdraw.
			const failed = await panel.state();
			assert.ok(failed.conversation?.transcript.some((item) => item.kind === "notice"));
			assert.equal(failed.conversation?.queued.length, 1);
			await panel.withdraw(queued);
			await until("the withdrawn item", () =>
				inboxItems(panel.view()).some((entry) => entry.id === queued) ? undefined : true,
			);
		} finally {
			if (previous === undefined) delete process.env.PDA_RUN_RETRY_ATTEMPTS;
			else process.env.PDA_RUN_RETRY_ATTEMPTS = previous;
			await panel.close();
		}
	});

	it("drains a queue that waited out a failed run as one batched turn", async () => {
		const previous = process.env.PDA_RUN_RETRY_ATTEMPTS;
		process.env.PDA_RUN_RETRY_ATTEMPTS = "0";
		const panel = await openPanel();
		try {
			let batched: { content?: unknown }[] = [];
			panel.faux.setResponses([
				toolCall("bash", { command: "sleep 0.3" }, "brief"),
				fauxAssistantMessage(fauxText("Answering would need the provider."), {
					stopReason: "error",
					errorMessage: "usage limit reached",
				}),
				(context) => {
					batched = context.messages;
					return fauxAssistantMessage(
						[
							fauxText("Back on. All three wishes done."),
							fauxToolCall(REPLY_TOOL, { message: "Back on. All three wishes done." }, { id: "batched" }),
						],
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage(fauxText("Nothing else to report.")),
			]);
			await panel.submit("Fail for me.");
			const first = await panel.submit("First wish.", "followUp");
			const second = await panel.submit("Second wish.", "followUp");
			await until("the run to fail", async () =>
				(await panel.state()).conversation?.status.busy === false ? true : undefined,
			);
			await until("both submissions still queued", () => {
				const ids = inboxItems(panel.view()).map((item) => item.id);
				return ids.length === 2 &&
					[...ids].sort((a, b) => a - b).join(",") === [first, second].sort((a, b) => a - b).join(",")
					? true
					: undefined;
			});

			// The same hook the server's supervisor fires on its own schedule, pressed here from the panel: a control
			// plane may wake the agent, and the fire is a whole turn against the model's budget.
			const fired = await panel.call("POST", `/api/admin/hooks/${RETRY_HOOK_ID}/fire`);
			assert.equal(fired.status, 200, JSON.stringify(fired.body));
			await until("the batched answer", () =>
				entries(panel.view()).some((entry) => messageText(entry) === "Back on. All three wishes done.")
					? true
					: undefined,
			);
			await until("idle, queue empty", async () => {
				const state = await panel.state();
				return state.conversation?.status.busy === false && inboxItems(panel.view()).length === 0
					? true
					: undefined;
			});
			assert.equal(
				entries(panel.view()).filter((entry) => entry.kind === "pi.assistant").length,
				4,
				"the three queued inputs were answered together",
			);
			const answered = batched
				.map((message) => JSON.stringify((message as { content?: unknown }).content))
				.join("\n");
			assert.match(answered, /First wish\./);
			assert.match(answered, /Second wish\./);
			assert.match(answered, /\[EVENT HOOK: Retry a failed run\]/);
			assert.equal(entries(panel.view()).filter((entry) => entry.kind === "app.hook").length, 1);
		} finally {
			if (previous === undefined) delete process.env.PDA_RUN_RETRY_ATTEMPTS;
			else process.env.PDA_RUN_RETRY_ATTEMPTS = previous;
			await panel.close();
		}
	});

	it("stops a running turn from the control plane", async () => {
		const panel = await openPanel();
		try {
			panel.faux.setResponses([
				toolCall("bash", { command: "sleep 30" }, "very-slow"),
				fauxAssistantMessage(fauxText("Never reached.")),
			]);
			await panel.submit("Start something long.");
			await until("running tools", async () =>
				(await panel.state()).conversation?.status.runStatus === "running_tools" ? true : undefined,
			);
			const stopped = await panel.call("POST", "/api/admin/control", { action: "stop" });
			assert.equal(stopped.status, 200);
			await until("idle after the stop", async () =>
				(await panel.state()).conversation?.status.runStatus === "idle" ? true : undefined,
			);
			assert.equal(
				entries(panel.view()).filter((entry) => entry.kind === "pi.assistant" && messageText(entry) !== "").length,
				0,
			);
		} finally {
			await panel.close();
		}
	});

	it("compacts when the conversation outgrows the policy, and the trace is where that is visible", async () => {
		const panel = await openPanel({
			contextWindow: 300,
			settings: { compaction: { reserveTokens: 1, keepRecentTokens: 1, backgroundTokens: 0 } },
		});
		try {
			const traceToken = await panel.granted(["conversation", "trace"]);
			panel.faux.setResponses([fauxAssistantMessage(fauxText("Hello there."))]);
			await panel.submit("Hello");
			await until("the first answer", () =>
				entries(panel.view()).some((entry) => entry.kind === "pi.assistant") ? true : undefined,
			);
			panel.faux.setResponses([
				fauxAssistantMessage(fauxText("Compressed history: the user greeted the agent.")),
				fauxAssistantMessage(fauxText("Answer after compaction.")),
			]);
			await panel.submit("Hello again");
			const compaction = await until("a compaction entry", () =>
				entries(panel.view()).find((entry) => entry.kind === "pi.compaction"),
			);
			assert.ok(
				["threshold", "overflow"].includes((compaction.data as { reason?: string } | undefined)?.reason ?? ""),
				`reason: ${JSON.stringify(compaction.data)}`,
			);
			await until("the second answer", () =>
				entries(panel.view()).some((entry) => messageText(entry) === "Answer after compaction.") ? true : undefined,
			);
			// The compaction is a prompt change: in the trace, never in the conversation the reader is sent.
			const traced = await panel.call("GET", "/api/admin/state", undefined, traceToken);
			assert.equal(traced.status, 200);
			const trace = (traced.body as PanelState).trace;
			assert.ok(trace !== undefined, "the trace device is sent the raw view");
			assert.ok(trace.entries.some((entry) => entry.kind === "pi.compaction"));
			const readable = await panel.state();
			assert.equal("trace" in readable, false, "a device without the grant is not sent it");
			assert.ok(!JSON.stringify(readable).includes("pi.compaction"));
		} finally {
			await panel.close();
		}
	});

	it("fires a hook from the panel, and the turn it starts answers proactively", async () => {
		const panel = await openPanel();
		try {
			panel.faux.setResponses([fauxAssistantMessage(fauxText("Proactive check done."))]);
			const fired = await panel.call("POST", "/api/admin/hooks/workspace-check/fire");
			assert.equal(fired.status, 200, JSON.stringify(fired.body));
			const hookEntry = await until("the hook entry", () =>
				entries(panel.view()).find((entry) => entry.kind === "app.hook"),
			);
			assert.equal((hookEntry.data as { hookName: string }).hookName, "Workspace check");
			await until("the proactive answer", () =>
				entries(panel.view()).some((entry) => messageText(entry) === "Proactive check done.") ? true : undefined,
			);
			const state = await panel.state();
			assert.equal(state.conversation?.status.hooks.find((hook) => hook.id === "workspace-check")?.fireCount, 1);
		} finally {
			await panel.close();
		}
	});

	it("sends the conversation and never the machine behind it", async () => {
		const panel = await openPanel();
		try {
			panel.faux.setResponses([
				fauxAssistantMessage(
					[
						fauxThinking("The token in the environment is hunter2, I will use it."),
						fauxToolCall(
							"bash",
							{ command: "curl -H 'authorization: Bearer hunter2' example.invalid" },
							{ id: "leaky" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxText("Working notes: the endpoint answered with token hunter2."),
						fauxToolCall(REPLY_TOOL, { message: "The endpoint is up." }, { id: "sent" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxText("Nothing else to report.")),
			]);
			await panel.submit("Check the endpoint.");
			await until("the delivered message", async () =>
				(await panel.state()).conversation?.transcript.some((item) => item.kind === "delivered") === true
					? true
					: undefined,
			);
			const state = await panel.state();
			assert.deepEqual(
				state.conversation?.transcript.map((item) => item.kind),
				["user", "delivered"],
			);
			const wire = JSON.stringify(state);
			for (const leak of ["hunter2", "thinking", "toolCall", "toolResult", "pi.assistant", "pi.user"]) {
				assert.ok(!wire.includes(leak), `the state carries no ${leak}`);
			}
			await until("idle", async () =>
				(await panel.state()).conversation?.status.busy === false ? true : undefined,
			);
			assert.deepEqual((await panel.state()).conversation?.status.runningTools, []);
			assert.ok(!JSON.stringify(await panel.state()).includes("hunter2"));
		} finally {
			await panel.close();
		}
	});

	it("offers the widget tool on every turn and settles a generateSandboxedUi call", async () => {
		const panel = await openPanel();
		try {
			panel.faux.setResponses([fauxAssistantMessage(fauxText("Ready when you are."))]);
			await panel.submit("Hello");
			await until("the first answer", () =>
				entries(panel.view()).some((entry) => messageText(entry) === "Ready when you are.") ? true : undefined,
			);
			const firstTurnTools = offeredTools(panel.view());
			const firstTurnDeclarations = offeredDeclarations(panel.view());
			assert.ok(
				firstTurnTools.includes("generateSandboxedUi"),
				`the widget tool is in the first turn's loadout: ${firstTurnTools.join(", ")}`,
			);

			panel.faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall(
							"generateSandboxedUi",
							{
								initialHeight: 240,
								css: "body{font:14px system-ui}",
								html: ["<div id='w'>widget</div>"],
								jsFunctions: "function boot(){}",
								jsExpressions: ["boot()"],
							},
							{ id: "ui" },
						),
						fauxToolCall("bash", { command: "sleep 1" }, { id: "after-ui" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxText("Here is the widget.")),
			]);
			await panel.submit("Show me a widget.");
			const slot = await until("the widget tool slot", () =>
				live(panel.view())?.tools?.find((entry) => entry.name === "generateSandboxedUi"),
			);
			assert.ok(["pending", "running", "done"].includes(slot.status));
			const widgets = await until("the widget in the transcript", async () => {
				const state = await panel.state();
				const found = state.conversation?.transcript.filter((item) => item.kind === "widget");
				return found !== undefined && found.length === 1 ? found : undefined;
			});
			assert.deepEqual((widgets[0] as { content?: { html?: string[] } }).content?.html, [
				"<div id='w'>widget</div>",
			]);
			await until("idle", async () =>
				(await panel.state()).conversation?.status.busy === false ? true : undefined,
			);

			// The loadout the second turn was offered is the first one, in the same order: no tool appears or
			// disappears mid-conversation, so the prefix the provider caches stays valid.
			assert.deepEqual(offeredTools(panel.view()), firstTurnTools, "a second turn offers the same tools in order");
			assert.deepEqual(
				offeredDeclarations(panel.view()),
				firstTurnDeclarations,
				"and the same declarations, so the cached prefix stays valid",
			);

			const prompt = renderedSections(panel.view());
			assert.deepEqual(
				[...prompt.keys()],
				promptSectionKeys().filter((key) => key !== "integrations"),
				"the model reads exactly the sections prompt.ts declares, in that order",
			);
			assert.match(prompt.get("generative_ui") ?? "", /generative-ui/);
		} finally {
			await panel.close();
		}
	});
});

describe("the grants", () => {
	it("decides which areas of the state exist, and what a write answers", async () => {
		const panel = await openPanel();
		try {
			const none = await panel.granted([]);
			const bare = await panel.call("GET", "/api/admin/state", undefined, none);
			assert.equal(bare.status, 200);
			const bareState = bare.body as PanelState;
			assert.deepEqual(bareState.session.grants, []);
			assert.deepEqual(Object.keys(bareState).sort(), ["now", "session"], "no grant, no area");
			assert.equal(grantsOf({ grants: undefined }).length, 0);

			// The two script routes carry the area their grant covers, and nothing for a device without it.
			assert.equal((await panel.call("GET", "/api/status", undefined, none)).status, 403);
			assert.equal((await panel.call("GET", "/api/integrations", undefined, none)).status, 403);

			const conversation = await panel.granted(["conversation"]);
			const reader = (await panel.call("GET", "/api/admin/state", undefined, conversation)).body as PanelState;
			assert.ok(reader.conversation !== undefined);
			assert.equal("trace" in reader, false);
			assert.equal("permissions" in reader, false);
			assert.equal("config" in reader, false);
			// Control is a conversation power; administration is not.
			assert.equal(
				(await panel.call("POST", "/api/admin/control", { action: "compact" }, conversation)).status,
				200,
			);
			// There is no third control: `clear` is not an action, so a conversation device gets the sentence and an
			// administrator has no way to lose the context from here at all.
			assert.equal((await panel.call("POST", "/api/admin/control", { action: "clear" }, conversation)).status, 400);
			assert.equal(
				(await panel.call("PUT", "/api/admin/connectors/github", { enabled: false }, conversation)).status,
				403,
			);
			assert.equal((await panel.call("GET", "/api/permissions", undefined, conversation)).status, 403);
			assert.equal((await panel.call("GET", "/api/status", undefined, conversation)).status, 200);
			assert.equal((await panel.call("GET", "/api/integrations", undefined, conversation)).status, 403);

			const approver = await panel.granted(["approve"]);
			const questions = await panel.call("GET", "/api/permissions", undefined, approver);
			assert.equal(questions.status, 200);
			assert.deepEqual(questions.body, { permissions: [] });
			assert.equal((await panel.call("GET", "/api/admin/state", undefined, approver)).body.config, undefined);

			const admin = await panel.granted(["admin"]);
			const config = (await panel.call("GET", "/api/admin/state", undefined, admin)).body as PanelState;
			assert.equal(config.conversation, undefined, "administration is not the conversation");
			assert.equal("trace" in config, false, "and it is not the trace");
			assert.ok(config.config !== undefined);
			assert.ok(config.config?.hooks.some((hook) => hook.id === "workspace-check"));
			assert.deepEqual(config.config?.grants, ["conversation", "admin", "approve", "trace"]);
			assert.equal(config.config?.restartRequired, false);
		} finally {
			await panel.close();
		}
	});

	it("cannot be widened by the device that holds it, and a revoke lands without a restart", async () => {
		const panel = await openPanel();
		try {
			const traceDevice = await panel.granted(["conversation", "trace"]);
			const traced = (await panel.call("GET", "/api/admin/state", undefined, traceDevice)).body as PanelState;
			assert.ok(traced.trace !== undefined);
			assert.ok(traced.trace.entries.length === 0);
			assert.equal((await panel.call("POST", "/api/admin/control", { action: "stop" }, traceDevice)).status, 200);
			// The trace is a read, not a write: no administrative route is open to it.
			assert.equal((await panel.call("GET", "/api/admin/state")).body.config !== undefined, true);

			// Narrowing is a write by an administrator, and the very next read is the narrowed one.
			const tokens = (await panel.state()).config?.tokens ?? [];
			const record = tokens.find((token) => token.label === "test-conversation-trace");
			assert.ok(record !== undefined);
			const narrowed = await panel.call("PATCH", `/api/admin/tokens/${record.id}`, { grants: ["conversation"] });
			assert.equal(narrowed.status, 200);
			const after = await panel.call("GET", "/api/admin/state", undefined, traceDevice);
			assert.equal((after.body as PanelState).trace, undefined, "the revoked grant is gone on the next request");
		} finally {
			await panel.close();
		}
	});
});

describe("the configuration the panel writes", () => {
	it("edits a connector's grant and says a restart is needed", async () => {
		const panel = await openPanel();
		try {
			await addPerson(housePaths(panel.home), "Ilya");
			// A name is the one field whose refusal quotes what the operator typed, so a typo has to be a sentence in the
			// form and not a stack in the log — including a quote, which used to break the classification itself.
			for (const name of ["Bad_Name", 'x"y']) {
				const refused = await panel.call("POST", "/api/admin/connectors", {
					name,
					description: "tools",
					tools: { url: "http://127.0.0.1:9/mcp" },
				});
				assert.equal(refused.status, 400, `${name}: ${JSON.stringify(refused.body)}`);
				assert.match(refused.body.error, /is not a usable name/);
			}
			const created = await panel.call("POST", "/api/admin/connectors", {
				name: "github",
				description: "GitHub issues and pull requests",
				tools: { url: "http://mason-github:8082/mcp" },
			});
			assert.equal(created.status, 200, JSON.stringify(created.body));
			assert.equal((await panel.state()).config?.restartRequired, true);
			assert.equal((await panel.state()).config?.health.some((entry) => entry.name === "github") ?? true, false);

			const granted = await panel.call("PUT", "/api/admin/connectors/github", {
				connector: {
					user: {
						actors: { "8811": "Ilya" },
						conversations: [{ externalConversationId: "-1001234", kind: "room", title: "Team" }],
						unattributed: false,
						approver: "8811",
					},
					events: { hooks: { "issue-opened": "github-activity" } },
					state: ["status", "projection"],
					commands: ["stop", "status"],
					trustMarkers: true,
					policy: { allow: ["issues.list"], deny: ["issues.delete"] },
				},
			});
			assert.equal(granted.status, 200, JSON.stringify(granted.body));
			const config = (await panel.state()).config;
			const entry = config?.connectors.find((connector) => connector.name === "github");
			assert.equal(entry?.connector?.user?.actors["8811"], "Ilya");
			assert.equal(entry?.connector?.user?.approver, "8811");
			assert.deepEqual(entry?.connector?.state, ["status", "projection"]);
			assert.equal(entry?.connector?.trustMarkers, true);
			assert.deepEqual(entry?.connector?.policy?.deny, ["issues.delete"]);
			assert.deepEqual(entry?.connector?.commands, ["stop", "status"]);

			// The file is the truth: what the panel wrote is what the next boot reads.
			const file = JSON.parse(await readFile(housePaths(panel.home).integrations, "utf8")) as {
				integrations: { github: Record<string, unknown> };
			};
			assert.deepEqual((file.integrations.github.connector as { state: string[] }).state, ["status", "projection"]);
			assert.deepEqual((file.integrations.github.connector as { commands: string[] }).commands, ["stop", "status"]);
			assert.deepEqual(file.integrations.github.tools, { url: "http://mason-github:8082/mcp" });

			// A control the protocol does not have is refused before it is written, naming the whole set.
			const refused = await panel.call("PUT", "/api/admin/connectors/github", {
				connector: { state: ["status"], commands: ["stopp"], trustMarkers: false },
			});
			assert.equal(refused.status, 400, JSON.stringify(refused.body));
			assert.match(refused.body.error, /"stopp"/);
			assert.match(refused.body.error, /stop, compact, clear, status/);

			// A credential is only issued for an entry with a grant to open.
			const minted = await panel.call("POST", "/api/admin/connectors/github/credential", { replace: false });
			assert.equal(minted.status, 200, JSON.stringify(minted.body));
			assert.match(minted.body.credential, /^masonc_/);
			assert.equal((await panel.state()).config?.credentials.length, 1);
			assert.equal((await panel.call("DELETE", `/api/admin/credentials/${minted.body.id}`)).status, 200);
			assert.equal((await panel.state()).config?.credentials.length, 0);
			assert.equal((await panel.call("DELETE", "/api/admin/connectors/github")).status, 200);
			assert.equal((await panel.state()).config?.connectors.length, 0);
		} finally {
			await panel.close();
		}
	});

	it("mints a device with the grants asked for, and rewrites the roster", async () => {
		const panel = await openPanel();
		try {
			const minted = await panel.call("POST", "/api/admin/tokens", {
				label: "phone",
				grants: ["conversation", "trace"],
			});
			assert.equal(minted.status, 200, JSON.stringify(minted.body));
			assert.match(minted.body.token, /^mason_/);
			const state = await panel.call("GET", "/api/admin/state", undefined, minted.body.token);
			assert.equal((state.body as PanelState).trace !== undefined, true, "the minted token works at once");
			const stored = await readConfig(panel.home);
			const record = stored.tokens?.find((token) => token.id === minted.body.id);
			assert.deepEqual(record?.grants, ["conversation", "trace"]);
			assert.equal(
				JSON.stringify(stored).includes(minted.body.token),
				false,
				"the file holds the hash, never the token",
			);

			assert.equal((await panel.call("POST", "/api/admin/roster", { name: "Ilya" })).status, 200);
			assert.equal((await panel.call("POST", "/api/admin/roster", { name: "ilya" })).status, 409);
			assert.deepEqual(
				(await panel.state()).config?.roster.map((person) => person.name),
				["Ilya"],
			);
			assert.equal((await panel.call("DELETE", "/api/admin/roster/Ilya")).status, 200);
			assert.deepEqual((await panel.state()).config?.roster, []);

			// A hook's switch is the process's, not the file's: it lands now, and the state says so.
			const off = await panel.call("PATCH", "/api/admin/hooks/workspace-check", { enabled: false });
			assert.equal(off.status, 200);
			assert.equal(
				(await panel.state()).config?.hooks.find((hook) => hook.id === "workspace-check")?.enabled,
				false,
			);
		} finally {
			await panel.close();
		}
	});
});
