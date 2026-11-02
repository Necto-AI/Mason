/**
 * Milestone 2 + 3 (wire level): a real Chord client in browser mode over a WebSocket sees the durable
 * conversation live — hydration, streaming status, tool transitions, the inbox queue, abort, proactive
 * hooks, and the `generateSandboxedUi` tool that is registered for every conversation.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createHost, type Host, type WebSocketLike, webSocketLink } from "@earendil-works/chord";
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
import { WebSocket } from "ws";
import { housePaths } from "../src/server/house.ts";
import { type RunningServer, startServer } from "../src/server/main.ts";
import { promptSectionKeys } from "../src/server/prompt.ts";
import { addPerson } from "../src/server/roster.ts";
import { RETRY_HOOK_ID } from "../src/server/run-retry.ts";
import type { ResolvedModel } from "../src/server/runtime.ts";
import {
	AgentService,
	type AgentStatus,
	type QueuedItem,
	REPLY_TOOL,
	type TranscriptItem,
} from "../src/shared/contract.ts";

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

async function waitFor<T>(what: string, read: () => T | undefined, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** A remote state hydrates only while someone subscribes, so the client keeps a subscription and a snapshot. */
interface State {
	/** What the client receives: the projection. */
	transcript?: TranscriptItem[];
	queued?: QueuedItem[];
	agentStatus?: AgentStatus;
	/** What only the server sees: the committed conversation the projection is derived from. */
	serverView?: ConversationView;
	readonly runStatuses: string[];
}

interface Client {
	readonly server: RunningServer;
	readonly browser: Host<{ kind: "server" }>;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly agent: Ref;
	readonly state: State;
	readonly close: () => Promise<void>;
}

type Ref = ReturnType<ReturnType<typeof createHost<{ kind: "server" }>>["hold"]> & {
	transcript: { subscribe(listener: (value: TranscriptItem[] | undefined) => void): () => void };
	queued: { subscribe(listener: (value: QueuedItem[] | undefined) => void): () => void };
	agentStatus: { subscribe(listener: (value: AgentStatus | undefined) => void): () => void };
	submit(args: { content: string; whenBusy?: "followUp" | "steer" | "reject" }): Promise<{ submissionId: number }>;
	withdrawSubmission(args: { submissionId: number }): Promise<void>;
	abort(): Promise<void>;
	fireHook(args: { hookId: string; payload?: string; requestId?: string }): Promise<{ submissionId: number }>;
	toggleHook(args: { hookId: string; enabled: boolean }): Promise<void>;
};

/**
 * The HTTP half of the join screen: pair a browser, claim a name off the roster, and keep the cookie it then sends.
 *
 * A person is fixed at handshake, so a socket has to carry the cookie the claim produced — which is what makes the
 * submit path reachable here: the server reads the person off the principal, not off the method's arguments.
 */
async function joinAs(server: RunningServer, home: string, name: string): Promise<string> {
	assert.equal(
		(await addPerson(housePaths(home), name)).ok,
		true,
		`${name} is on the roster before the browser claims it`,
	);
	const paired = await fetch(
		`http://127.0.0.1:${server.port}/?token=${encodeURIComponent(server.pairingToken ?? "")}`,
		{
			redirect: "manual",
		},
	);
	const device = (paired.headers.getSetCookie().join("\n").split(";")[0] as string).trim();
	const claimed = await fetch(`http://127.0.0.1:${server.port}/api/join`, {
		method: "POST",
		headers: { cookie: device, "content-type": "application/json" },
		body: JSON.stringify({ name }),
	});
	assert.equal(claimed.status, 200);
	return (claimed.headers.getSetCookie().join("\n").split(";")[0] as string).trim();
}

async function openClient(
	extra: {
		settings?: NonNullable<Parameters<typeof startServer>[0]>["settings"];
		contextWindow?: number;
		/** A name on the roster this browser claims before it opens the socket. */
		person?: string;
	} = {},
): Promise<Client> {
	const directory = await mkdtemp(join(tmpdir(), "pda-chord-"));
	directories.add(directory);
	const { access, faux } = fauxAccess(extra.contextWindow);
	// The agent's home is a temporary directory, never the real `~/.mason`: the runtime creates it through
	// `houseHome`, and the prompt sections (soul, profile, skills) resolve the same one through `MASON_HOME`.
	const houseHome = join(directory, "house");
	const previousHouseHome = process.env.MASON_HOME;
	process.env.MASON_HOME = houseHome;
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
	// A fresh home mints a token on first start; a real browser takes the same one from `?token=` once, and a browser
	// that has claimed a name sends the cookie that claim set instead.
	const cookie = extra.person === undefined ? undefined : await joinAs(server, houseHome, extra.person);
	const browser = createHost<{ kind: "server" }>({
		self: { kind: "server" },
		name: "browser",
		kind: "client",
		upstream: {
			link: webSocketLink(
				(cookie === undefined
					? new WebSocket(`ws://127.0.0.1:${server.port}/?token=${server.pairingToken ?? ""}`)
					: new WebSocket(`ws://127.0.0.1:${server.port}/`, { headers: { cookie } })) as unknown as WebSocketLike,
			),
			principal: { kind: "server" },
		},
		onError: () => {},
	});
	const agent = browser.hold(AgentService, {}) as unknown as Ref;
	const state: State = { runStatuses: [] };
	// The raw view, watched server-side: the tests assert both what the client is sent and what stays behind.
	const raw = await server.runtime.viewState(BACKGROUND_CONTEXT);
	raw.subscribe((value) => {
		state.serverView = value;
	});
	agent.transcript.subscribe((value) => {
		state.transcript = value;
	});
	agent.queued.subscribe((value) => {
		state.queued = value;
	});
	agent.agentStatus.subscribe((value) => {
		state.agentStatus = value;
		if (value !== undefined) state.runStatuses.push(value.runStatus);
	});
	return {
		server,
		browser,
		faux,
		agent,
		state,
		async close() {
			await raw.dispose();
			await browser.close();
			await server.close();
			if (previousHouseHome === undefined) delete process.env.MASON_HOME;
			else process.env.MASON_HOME = previousHouseHome;
		},
	};
}

function live(view: ConversationView | undefined) {
	return view?.docs["pi.live"] as
		| {
				run?: { taskId: number };
				generation?: { attempt: number };
				tools?: { callId: string; name: string; status: string; output?: string }[];
		  }
		| undefined;
}

function inboxItems(view: ConversationView | undefined): { id: number; mode: string }[] {
	return (view?.docs["pi.inbox"] as { items: { id: number; mode: string }[] } | undefined)?.items ?? [];
}

function entries(view: ConversationView | undefined) {
	return [...(view?.entries ?? [])];
}

function textOf(message: { content?: unknown } | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? "").join("");
	return "";
}

function messageText(entry: { model?: readonly unknown[] } | undefined): string {
	return textOf(entry?.model?.[0] as { content?: unknown } | undefined);
}

/** Sections in effect after replaying the `pi.system` entries: the prompt the next request is given. */
function renderedSections(view: ConversationView | undefined): Map<string, string> {
	const shown = new Map<string, string>();
	for (const entry of entries(view)) {
		for (const message of entry.model ?? []) {
			if (message.role !== "system" || message.sections === undefined) continue;
			for (const [key, value] of Object.entries(message.sections)) {
				if (value === null) shown.delete(key);
				else shown.set(key, value);
			}
		}
	}
	return shown;
}

/** The tools in effect after replaying the `pi.system` entries: the loadout the next request is offered. */
function offeredTools(view: ConversationView | undefined): string[] {
	return getCurrentTools(entries(view).flatMap((entry) => entry.model ?? [])).map((tool) => tool.name);
}

/** The loadout as the provider sees it: a changed description or schema breaks the cache even when the name is the same. */
function offeredDeclarations(view: ConversationView | undefined): string[] {
	return getCurrentTools(entries(view).flatMap((entry) => entry.model ?? [])).map((tool) => JSON.stringify(tool));
}

describe("chord client <-> server", () => {
	it("hydrates state, streams a run, and returns to idle", async () => {
		const client = await openClient();
		const { agent, state } = client;
		try {
			await agent.ready;
			// A turn delivers before it ends: the answer and the `reply` call are one message, and the turn closes
			// with a working note.
			client.faux.setResponses([
				fauxAssistantMessage(
					[
						fauxText("Hello from the agent."),
						fauxToolCall(REPLY_TOOL, { message: "Hello from the agent." }, { id: "hello" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxText("Nothing else to report.")),
			]);

			const initial = await waitFor("the initial view", () => state.serverView);
			assert.deepEqual(entries(initial), []);
			const status = await waitFor("the initial status", () => state.agentStatus);
			assert.equal(status.runStatus, "idle");
			assert.equal(status.busy, false);
			assert.deepEqual(
				status.hooks.map((hook) => hook.id),
				["morning-brief", "retry-failed-run", "github-activity", "workspace-check", "team-chat"],
			);
			assert.deepEqual(status.model, { provider: "faux", modelId: "faux-1" });

			const { submissionId } = await agent.submit({ content: "Hello" });
			assert.equal(typeof submissionId, "number");

			const answer = await waitFor("the answer", () => {
				const found = entries(state.serverView).find((entry) => entry.kind === "pi.assistant");
				return found === undefined ? undefined : found;
			});
			assert.equal(messageText(answer), "Hello from the agent.");
			await waitFor("idle again", () => (state.agentStatus?.busy === false ? true : undefined));
			// Read once the turn settles: the delivery step commits the call's result and the note that closes the turn
			// after the answer.
			assert.deepEqual(
				entries(state.serverView).map((entry) => entry.kind),
				// The reply's own entry sits between the call that asked for it and that call's result: the entry is the
				// delivery, so it is part of what the turn leaves behind.
				["pi.user", "pi.system", "pi.assistant", "app.reply", "pi.tool-result", "pi.assistant"],
			);
			assert.ok(state.runStatuses.includes("generating"), `saw generating: ${state.runStatuses.join(",")}`);
			assert.equal(state.agentStatus?.runStatus, "idle");
		} finally {
			await client.close();
		}
	});

	it("shows a running tool round, queues and withdraws a follow-up", async () => {
		const client = await openClient();
		const { agent, state } = client;
		try {
			await agent.ready;
			client.faux.setResponses([
				toolCall("bash", { command: "sleep 1.5" }, "slow"),
				// The answer is sent in the same message, so the turn delivers instead of ending in silence.
				fauxAssistantMessage(
					[
						fauxText("Slow command finished."),
						fauxToolCall(REPLY_TOOL, { message: "Slow command finished." }, { id: "slow-done" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxText("Nothing else to report.")),
			]);

			await agent.submit({ content: "Run something slow." });
			await waitFor("running tools", () => (state.agentStatus?.runStatus === "running_tools" ? true : undefined));
			const running = await waitFor("a running tool slot", () =>
				live(state.serverView)?.tools?.find((slot) => slot.status === "running"),
			);
			assert.equal(running.name, "bash");
			assert.equal(state.agentStatus?.busy, true);

			// A queued follow-up is visible to every client, and can be taken back while it waits.
			const queued = await agent.submit({ content: "Then check the logs.", whenBusy: "followUp" });
			const item = await waitFor("the queued item", () =>
				inboxItems(state.serverView).find((entry) => entry.id === queued.submissionId),
			);
			assert.equal(item.mode, "followUp");

			// A steer queues the same durable way, so the one row style and withdraw control cover both modes.
			const steered = await agent.submit({ content: "Also watch stderr.", whenBusy: "steer" });
			const steerItem = await waitFor("the queued steer", () =>
				inboxItems(state.serverView).find((entry) => entry.id === steered.submissionId),
			);
			assert.equal(steerItem.mode, "steer");

			// Each can be taken back before its boundary places it.
			await agent.withdrawSubmission({ submissionId: queued.submissionId });
			await agent.withdrawSubmission({ submissionId: steered.submissionId });
			await waitFor("both withdrawn items", () =>
				inboxItems(state.serverView).some(
					(entry) => entry.id === queued.submissionId || entry.id === steered.submissionId,
				)
					? undefined
					: true,
			);

			// The withdrawn submissions never run: the first answer ends the run.
			await waitFor("the answer", () =>
				entries(state.serverView).some((entry) => messageText(entry) === "Slow command finished.")
					? true
					: undefined,
			);
			await waitFor("idle", () => (state.agentStatus?.busy === false ? true : undefined));
			assert.equal(
				entries(state.serverView).filter((entry) => entry.kind === "pi.user").length,
				1,
				"the withdrawn follow-up was never placed",
			);
		} finally {
			await client.close();
		}
	});

	it("lets the reader's steer cut into a running turn", async () => {
		const client = await openClient();
		const { agent, state, faux } = client;
		try {
			await agent.ready;
			// The run's second round is recorded: a steer that cut in is in the context the running turn continues with.
			let afterSteer: { content?: unknown }[] = [];
			faux.setResponses([
				toolCall("bash", { command: "sleep 0.6" }, "slow"),
				(context) => {
					afterSteer = context.messages;
					return fauxAssistantMessage(fauxText("Watching stderr now."));
				},
			]);

			await agent.submit({ content: "Run something slow." });
			await waitFor("running tools", () => (state.agentStatus?.runStatus === "running_tools" ? true : undefined));
			await agent.submit({ content: "Also watch stderr.", whenBusy: "steer" });

			await waitFor("the steered answer", () =>
				entries(state.serverView).some((entry) => messageText(entry) === "Watching stderr now.") ? true : undefined,
			);
			assert.match(
				afterSteer.map((message) => textOf(message)).join("\n"),
				/Also watch stderr\./,
				"the steer reached the turn that was already running",
			);
			await waitFor("idle", () => (state.agentStatus?.busy === false ? true : undefined));
			assert.equal(inboxItems(state.serverView).length, 0, "the steer was placed, not left waiting");
		} finally {
			await client.close();
		}
	});

	it("shows the failed run's queue and lets it be withdrawn while nothing runs", async () => {
		// The supervisor would re-fire the failed run in the background; budgeted to 0, the queue has
		// nobody to pick it up, which is exactly what the user sees while the provider is down.
		const previous = process.env.PDA_RUN_RETRY_ATTEMPTS;
		process.env.PDA_RUN_RETRY_ATTEMPTS = "0";
		const client = await openClient();
		try {
			const { agent, state, faux } = client;
			await agent.ready;
			faux.setResponses([
				toolCall("bash", { command: "sleep 0.3" }, "brief"),
				fauxAssistantMessage(fauxText("Answering would need the provider."), {
					stopReason: "error",
					errorMessage: "usage limit reached",
				}),
			]);

			await agent.submit({ content: "Run a step, then hit the limit." });
			const queued = await agent.submit({ content: "When it works again, tell me.", whenBusy: "followUp" });

			// The run dies on the limit, nothing re-arms it, and the queued submission is still there: durable
			// inbox state for the restart to pick up, visible to the reader exactly as it will be processed.
			await waitFor("the failed answer", () =>
				entries(state.serverView).some(
					(entry) =>
						entry.kind === "pi.assistant" &&
						(entry.model?.[0] as { stopReason?: string } | undefined)?.stopReason === "error",
				)
					? true
					: undefined,
			);
			await waitFor("idle after the failure", () => (state.agentStatus?.busy === false ? true : undefined));
			assert.deepEqual(
				inboxItems(state.serverView).map((item) => ({ id: item.id, mode: item.mode })),
				[{ id: queued.submissionId, mode: "followUp" }],
			);
			assert.equal(live(state.serverView)?.run, undefined);

			// A queued submission stays the durable backend's to take back while the agent sits dead.
			await agent.withdrawSubmission({ submissionId: queued.submissionId });
			await waitFor("the withdrawn item", () =>
				inboxItems(state.serverView).some((entry) => entry.id === queued.submissionId) ? undefined : true,
			);
		} finally {
			if (previous === undefined) delete process.env.PDA_RUN_RETRY_ATTEMPTS;
			else process.env.PDA_RUN_RETRY_ATTEMPTS = previous;
			await client.close();
		}
	});

	it("drains a queue that waited out a failed run as one batched turn", async () => {
		const previous = process.env.PDA_RUN_RETRY_ATTEMPTS;
		process.env.PDA_RUN_RETRY_ATTEMPTS = "0"; // the manual hook fire plays the provider coming back
		const client = await openClient();
		try {
			const { agent, state, faux } = client;
			await agent.ready;
			// The batched turn's own context is recorded: batching is only real if the model saw all three inputs at once.
			let batched: { content?: unknown }[] = [];
			faux.setResponses([
				toolCall("bash", { command: "sleep 0.3" }, "brief"),
				fauxAssistantMessage(fauxText("Answering would need the provider."), {
					stopReason: "error",
					errorMessage: "usage limit reached",
				}),
				// `followUpMode: "all"`: whatever is waiting drains as one turn, and the model prioritises between it.
				(context) => {
					batched = context.messages;
					// The batch's answer is delivered in the same message, so the turn does not end in silence.
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

			await agent.submit({ content: "Fail for me." });
			const first = await agent.submit({ content: "First wish.", whenBusy: "followUp" });
			const second = await agent.submit({ content: "Second wish.", whenBusy: "followUp" });

			await waitFor("the run to fail", () => (state.agentStatus?.busy === false ? true : undefined));
			await waitFor("both submissions still queued", () => {
				const ids = inboxItems(state.serverView).map((item) => item.id);
				return ids.length === 2 &&
					[...ids].sort((a, b) => a - b).join(",") ===
						[first.submissionId, second.submissionId].sort((a, b) => a - b).join(",")
					? true
					: undefined;
			});

			// The same hook the server's supervisor fires on its own schedule. Its input is a follow-up like any
			// other, so it joins the batch instead of opening a turn of its own.
			await agent.fireHook({ hookId: RETRY_HOOK_ID, payload: "usage limit reached" });
			await waitFor("the batched answer", () =>
				entries(state.serverView).some((entry) => messageText(entry) === "Back on. All three wishes done.")
					? true
					: undefined,
			);
			await waitFor("idle, queue empty", () =>
				state.agentStatus?.busy === false && inboxItems(state.serverView).length === 0 ? true : undefined,
			);

			// One turn, not three: the failed run's tool call, its error, the batch's single answer, and the note that
			// closes the turn after the delivery.
			assert.equal(
				entries(state.serverView).filter((entry) => entry.kind === "pi.assistant").length,
				4,
				"the three queued inputs were answered together",
			);
			const answered = batched.map((message) => textOf(message)).join("\n");
			assert.match(answered, /First wish\./);
			assert.match(answered, /Second wish\./);
			assert.match(answered, /\[EVENT HOOK: Retry a failed run\]/);
			assert.equal(entries(state.serverView).filter((entry) => entry.kind === "app.hook").length, 1);
			assert.equal(
				entries(state.serverView).filter((entry) => entry.kind === "pi.user").length,
				3,
				"the two waiting submissions and the original prompt",
			);
		} finally {
			if (previous === undefined) delete process.env.PDA_RUN_RETRY_ATTEMPTS;
			else process.env.PDA_RUN_RETRY_ATTEMPTS = previous;
			await client.close();
		}
	});

	it("aborts a running conversation", async () => {
		const client = await openClient();
		const { agent, state } = client;
		try {
			await agent.ready;
			client.faux.setResponses([
				toolCall("bash", { command: "sleep 30" }, "very-slow"),
				fauxAssistantMessage(fauxText("Never reached.")),
			]);
			await agent.submit({ content: "Start something long." });
			await waitFor("running tools", () => (state.agentStatus?.runStatus === "running_tools" ? true : undefined));

			await agent.abort();
			await waitFor("idle after the abort", () => (state.agentStatus?.runStatus === "idle" ? true : undefined));
			assert.equal(
				entries(state.serverView).filter((entry) => entry.kind === "pi.assistant" && messageText(entry) !== "")
					.length,
				0,
			);
		} finally {
			await client.close();
		}
	});

	it("compacts when the conversation outgrows the policy", async (t) => {
		// A 300-token window makes even this short history overflow the policy's threshold.
		const client = await openClient({
			contextWindow: 300,
			settings: { compaction: { reserveTokens: 1, keepRecentTokens: 1, backgroundTokens: 0 } },
		});
		t.after(() => client.close());
		const { agent, state } = client;
		try {
			await waitFor("the initial view", () => state.serverView);
			// The threshold is measured against the usage of the previous request, so a first turn records it.
			client.faux.setResponses([fauxAssistantMessage(fauxText("Hello there."))]);
			await agent.submit({ content: "Hello" });
			await waitFor("the first answer", () =>
				(state.serverView?.entries ?? []).some((entry) => entry.kind === "pi.assistant") ? true : undefined,
			);
			// Second response is the summary the compaction task asks for, third the answer to the second prompt.
			client.faux.setResponses([
				fauxAssistantMessage(fauxText("Compressed history: the user greeted the agent.")),
				fauxAssistantMessage(fauxText("Answer after compaction.")),
			]);
			await agent.submit({ content: "Hello again" });
			const compaction = await waitFor("a compaction entry", () =>
				(state.serverView?.entries ?? []).find((entry) => entry.kind === "pi.compaction"),
			);
			assert.ok(
				["threshold", "overflow"].includes((compaction.data as { reason?: string } | undefined)?.reason ?? ""),
				`reason: ${JSON.stringify(compaction.data)}`,
			);
			// Compaction replaces the compacted span, so the check is on the answer's text, not on a count.
			await waitFor("the second answer", () =>
				(state.serverView?.entries ?? []).some(
					(entry) =>
						entry.kind === "pi.assistant" &&
						(
							(entry.model?.[0] as { content?: { type: string; text?: string }[] } | undefined)?.content ?? []
						).some((part) => part.type === "text" && part.text === "Answer after compaction."),
				)
					? true
					: undefined,
			);
		} finally {
			client.agent.release();
		}
	});

	it("fires a hook from the client, and the turn it starts answers proactively", async () => {
		const client = await openClient();
		const { agent, state } = client;
		try {
			await agent.ready;
			client.faux.setResponses([fauxAssistantMessage(fauxText("Proactive check done."))]);
			await agent.fireHook({ hookId: "workspace-check" });
			const hookEntry = await waitFor("the hook entry", () =>
				entries(state.serverView).find((entry) => entry.kind === "app.hook"),
			);
			assert.equal((hookEntry.data as { hookName: string }).hookName, "Workspace check");
			await waitFor("the proactive answer", () =>
				entries(state.serverView).some((entry) => messageText(entry) === "Proactive check done.")
					? true
					: undefined,
			);
			await waitFor("the hook counter", () =>
				state.agentStatus?.hooks.find((hook) => hook.id === "workspace-check")?.fireCount === 1 ? true : undefined,
			);
		} finally {
			await client.close();
		}
	});

	it("sends the reader's conversation and never the machine behind it", async () => {
		const client = await openClient();
		const { agent, state, faux } = client;
		try {
			await agent.ready;
			// A turn with everything the reader must not see: reasoning, a tool call with a secret in its arguments, a
			// tool result with a secret in its output, and prose that is working notes. One `reply`, then the note
			// that closes the turn.
			faux.setResponses([
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

			await agent.submit({ content: "Check the endpoint." });
			await waitFor("the delivered message", () =>
				state.transcript?.some((item) => item.kind === "delivered") === true ? true : undefined,
			);
			await waitFor("idle", () => (state.agentStatus?.busy === false ? true : undefined));

			// What arrived is the conversation: the reader's message and the message the agent chose to send.
			assert.deepEqual(
				state.transcript?.map((item) => item.kind),
				["user", "delivered"],
			);
			assert.deepEqual(
				state.transcript
					?.filter((item) => item.kind === "delivered")
					.map((item) => (item as { text: string }).text),
				["The endpoint is up."],
			);

			// Nothing of the machine is on the wire: no reasoning, no tool call, no tool output, no entries.
			const wire = JSON.stringify({ transcript: state.transcript, queued: state.queued, status: state.agentStatus });
			for (const leak of ["hunter2", "thinking", "toolCall", "toolResult", "pi.assistant", "pi.user", "text:"]) {
				assert.ok(!wire.includes(leak), `the wire carries no ${leak}`);
			}
			// The status names what runs, and nothing more: a tool name is the whole of it.
			assert.deepEqual(state.agentStatus?.runningTools, []);
		} finally {
			await client.close();
		}
	});

	it("names the tools of a running round without their arguments or output", async () => {
		const client = await openClient();
		const { agent, state, faux } = client;
		try {
			await agent.ready;
			faux.setResponses([
				toolCall("bash", { command: "sleep 0.8 && echo hunter2" }, "secretive"),
				fauxAssistantMessage(fauxText("Done.")),
			]);

			await agent.submit({ content: "Run something secret." });
			// The working line a reader sees while tools run: the name, never the command.
			const names = await waitFor("the running tool names", () =>
				state.agentStatus?.runningTools.length === 0 ? undefined : state.agentStatus?.runningTools,
			);
			assert.deepEqual(names, ["bash"]);
			const wire = JSON.stringify({ status: state.agentStatus, transcript: state.transcript });
			assert.ok(!wire.includes("hunter2"), "the command never reaches the client");
			await waitFor("idle", () => (state.agentStatus?.busy === false ? true : undefined));
		} finally {
			await client.close();
		}
	});

	it("offers the widget tool on every turn and settles a generateSandboxedUi call", async () => {
		const client = await openClient();
		const { agent, state } = client;
		try {
			await agent.ready;
			await waitFor("the initial view", () => state.serverView);

			// There is no toggle to open: a plain first turn is offered the widget tool already.
			client.faux.setResponses([fauxAssistantMessage(fauxText("Ready when you are."))]);
			await agent.submit({ content: "Hello" });
			await waitFor("the first answer", () =>
				entries(state.serverView).some((entry) => messageText(entry) === "Ready when you are.") ? true : undefined,
			);
			const firstTurnTools = offeredTools(state.serverView);
			const firstTurnDeclarations = offeredDeclarations(state.serverView);
			assert.ok(
				firstTurnTools.includes("generateSandboxedUi"),
				`the widget tool is in the first turn's loadout: ${firstTurnTools.join(", ")}`,
			);

			client.faux.setResponses([
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

			await agent.submit({ content: "Show me a widget." });
			const slot = await waitFor("the widget tool slot", () =>
				live(state.serverView)?.tools?.find((entry) => entry.name === "generateSandboxedUi"),
			);
			assert.ok(["pending", "running", "done"].includes(slot.status));

			await waitFor("the widget tool result", () =>
				entries(state.serverView).some(
					(entry) =>
						entry.kind === "pi.tool-result" &&
						(entry.model?.[0] as { toolName?: string }).toolName === "generateSandboxedUi",
				)
					? true
					: undefined,
			);
			await waitFor("the answer", () =>
				entries(state.serverView).some((entry) => messageText(entry) === "Here is the widget.") ? true : undefined,
			);
			await waitFor("idle", () => (state.agentStatus?.busy === false ? true : undefined));
			// The reader is sent the widget itself — nothing gated it, and the call that built it stays on the server.
			const widgets = state.transcript?.filter((item) => item.kind === "widget") ?? [];
			assert.equal(widgets.length, 1, "the settled widget is one row of the reader's transcript");
			assert.deepEqual((widgets[0] as { content?: { html?: string[] } }).content?.html, [
				"<div id='w'>widget</div>",
			]);
			// The loadout the second turn was offered is the first one, in the same order: no tool appears or
			// disappears mid-conversation, so the prefix the provider caches stays valid.
			assert.deepEqual(
				offeredTools(state.serverView),
				firstTurnTools,
				"a second turn offers the same tools in order",
			);
			assert.deepEqual(
				offeredDeclarations(state.serverView),
				firstTurnDeclarations,
				"and the same declarations, so the cached prefix stays valid",
			);

			// What the renderer reads: the settled arguments of the tool call in the assistant entry.
			const call = entries(state.serverView)
				.flatMap((entry) =>
					entry.kind === "pi.assistant" ? ((entry.model?.[0] as { content?: unknown[] }).content ?? []) : [],
				)
				.find((part) => (part as { name?: string }).name === "generateSandboxedUi") as
				| { arguments: { css?: string; html?: string[]; jsExpressions?: string[] } }
				| undefined;
			assert.equal(call?.arguments.css, "body{font:14px system-ui}");
			assert.deepEqual(call?.arguments.html, ["<div id='w'>widget</div>"]);
			assert.deepEqual(call?.arguments.jsExpressions, ["boot()"]);

			// The resident section is a pointer to the skill, not the manual: the parameter order, the design system
			// and the sandbox API live in `skills/generative-ui/SKILL.md` and cost nothing until they are read.
			const prompt = renderedSections(state.serverView);
			assert.deepEqual(
				[...prompt.keys()],
				// `integrations` is declared but has no text here: this boot has no integration with a tools face, and a
				// section nobody can fill is left out of the prompt rather than rendered as an empty header.
				promptSectionKeys().filter((key) => key !== "integrations"),
				"the model reads exactly the sections prompt.ts declares, in that order",
			);
			const rendered = [...prompt.values()].join("\n");
			assert.match(prompt.get("generative_ui") ?? "", /generative-ui/, "the resident section names the skill");
			assert.match(rendered, /generative-ui/, "the widget contract is reachable from the prompt");
			assert.ok(
				!rendered.includes("initialHeight — estimated finished height in pixels"),
				"the parameter order lives in the skill, not in the prompt",
			);
			assert.ok(
				!rendered.includes("Websandbox.connection.remote.sendPrompt"),
				"the sandbox API manual lives in the skill, not in the prompt",
			);
		} finally {
			await client.close();
		}
	});

	it("writes the name of the person who spoke into the message the model reads", async () => {
		// Everything above happens with an unnamed device. This is the same wire with a browser that claimed a name: the
		// author is written by `submit` into the durable entry, so it is a claim the server made and the model can follow.
		const client = await openClient({ person: "Ilya" });
		const { agent, state } = client;
		try {
			await agent.ready;
			client.faux.setResponses([
				fauxAssistantMessage(
					[fauxText("On it."), fauxToolCall(REPLY_TOOL, { message: "On it." }, { id: "on-it" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxText("Nothing else to report.")),
			]);

			await agent.submit({ content: "Ship the deploy." });

			// The durable entry is the whole record: a plain `pi.user` message whose text names its author.
			const spoken = await waitFor("the message in the conversation", () =>
				entries(state.serverView).find((entry) => entry.kind === "pi.user"),
			);
			assert.equal(messageText(spoken), "[from Ilya] Ship the deploy.");

			// The reader gets the same fact as a chip: what they typed, and who the server says said it.
			const row = await waitFor("the transcript row", () => state.transcript?.find((item) => item.kind === "user"));
			assert.deepEqual(row, { kind: "user", id: String(spoken.id), text: "Ship the deploy.", author: "Ilya" });
			await waitFor("idle again", () => (state.agentStatus?.busy === false ? true : undefined));
		} finally {
			await client.close();
		}
	});
});
