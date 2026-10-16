/**
 * Milestone 2 + 3 (wire level): a real Chord client in browser mode over a WebSocket sees the durable
 * conversation live — hydration, streaming status, tool transitions, the inbox queue, abort, proactive
 * hooks, and the `generateSandboxedUi` tool behind its toggle.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createHost, type Host, webSocketLink, type WebSocketLike } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import { RETRY_HOOK_ID } from "../src/server/run-retry.ts";
import { startServer, type RunningServer } from "../src/server/main.ts";
import type { ResolvedModel } from "../src/server/runtime.ts";
import { AgentService, type AgentStatus } from "../src/shared/contract.ts";

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
	view?: ConversationView;
	agentStatus?: AgentStatus;
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

type Ref = ReturnType<ReturnType<typeof createHost<{ kind: "server" }>>["get"]> & {
	view: { subscribe(listener: (value: ConversationView | undefined) => void): () => void };
	agentStatus: { subscribe(listener: (value: AgentStatus | undefined) => void): () => void };
	submit(args: { content: string; whenBusy?: "followUp" | "steer" | "reject" }): Promise<{ submissionId: number }>;
	withdrawSubmission(args: { submissionId: number }): Promise<void>;
	abort(): Promise<void>;
	fireHook(args: { hookId: string; payload?: string }): Promise<{ submissionId: number }>;
	toggleHook(args: { hookId: string; enabled: boolean }): Promise<void>;
	setSandboxedUiEnabled(args: { enabled: boolean }): Promise<void>;
};

async function openClient(
	extra: { settings?: NonNullable<Parameters<typeof startServer>[0]>["settings"]; contextWindow?: number } = {},
): Promise<Client> {
	const directory = await mkdtemp(join(tmpdir(), "pda-chord-"));
	directories.add(directory);
	const { access, faux } = fauxAccess(extra.contextWindow);
	const server = await startServer({
		port: 0,
		hostname: "127.0.0.1",
		storage: "memory",
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		modelAccess: access,
		// Explicit, so an `ENABLE_SANDBOXED_UI=1` in the ambient environment cannot flip the default under test.
		enableSandboxedUi: false,
		...(extra.settings === undefined ? {} : { settings: extra.settings }),
		onReport: () => {},
	});
	const browser = createHost<{ kind: "server" }>({
		self: { kind: "server" },
		name: "browser",
		kind: "client",
		upstream: {
			link: webSocketLink(new WebSocket(`ws://127.0.0.1:${server.port}/`) as unknown as WebSocketLike),
			principal: { kind: "server" },
		},
		onError: () => {},
	});
	const agent = browser.get(AgentService, {}) as unknown as Ref;
	const state: State = { runStatuses: [] };
	agent.view.subscribe((value) => {
		state.view = value;
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
			await browser.close();
			await server.close();
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

function messageText(entry: { model?: readonly unknown[] } | undefined): string {
	const content = (entry?.model?.[0] as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? "").join("");
	return "";
}

function sections(view: ConversationView | undefined): Record<string, string | null>[] {
	return entries(view)
		.filter((entry) => entry.kind === "pi.system")
		.map((entry) => (entry.model?.[0] as { sections?: Record<string, string | null> } | undefined)?.sections ?? {});
}

describe("chord client <-> server", () => {
	it("hydrates state, streams a run, and returns to idle", async () => {
		const client = await openClient();
		const { agent, state } = client;
		try {
			await agent.ready;
			client.faux.setResponses([fauxAssistantMessage(fauxText("Hello from the agent."))]);

			const initial = await waitFor("the initial view", () => state.view);
			assert.deepEqual(entries(initial), []);
			const status = await waitFor("the initial status", () => state.agentStatus);
			assert.equal(status.runStatus, "idle");
			assert.equal(status.busy, false);
			assert.equal(status.sandboxedUiEnabled, false);
			assert.deepEqual(
				status.hooks.map((hook) => hook.id),
				["morning-brief", "retry-failed-run", "workspace-check"],
			);
			assert.deepEqual(status.model, { provider: "faux", modelId: "faux-1" });

			const { submissionId } = await agent.submit({ content: "Hello" });
			assert.equal(typeof submissionId, "number");

			const answer = await waitFor("the answer", () => {
				const found = entries(state.view).find((entry) => entry.kind === "pi.assistant");
				return found === undefined ? undefined : found;
			});
			assert.equal(messageText(answer), "Hello from the agent.");
			assert.deepEqual(
				entries(state.view).map((entry) => entry.kind),
				["pi.user", "pi.system", "pi.assistant"],
			);
			await waitFor("idle again", () => (state.agentStatus?.busy === false ? true : undefined));
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
				fauxAssistantMessage(fauxText("Slow command finished.")),
			]);

			await agent.submit({ content: "Run something slow." });
			await waitFor("running tools", () =>
				state.agentStatus?.runStatus === "running_tools" ? true : undefined,
			);
			const running = await waitFor("a running tool slot", () =>
				live(state.view)?.tools?.find((slot) => slot.status === "running"),
			);
			assert.equal(running.name, "bash");
			assert.equal(state.agentStatus?.busy, true);

			// A queued follow-up is visible to every client, and can be taken back while it waits.
			const queued = await agent.submit({ content: "Then check the logs.", whenBusy: "followUp" });
			const item = await waitFor("the queued item", () =>
				inboxItems(state.view).find((entry) => entry.id === queued.submissionId),
			);
			assert.equal(item.mode, "followUp");

			// A steer queues the same durable way, so the one row style and withdraw control cover both modes.
			const steered = await agent.submit({ content: "Also watch stderr.", whenBusy: "steer" });
			const steerItem = await waitFor("the queued steer", () =>
				inboxItems(state.view).find((entry) => entry.id === steered.submissionId),
			);
			assert.equal(steerItem.mode, "steer");

			// Each can be taken back before its boundary places it.
			await agent.withdrawSubmission({ submissionId: queued.submissionId });
			await agent.withdrawSubmission({ submissionId: steered.submissionId });
			await waitFor("both withdrawn items", () =>
				inboxItems(state.view).some(
					(entry) => entry.id === queued.submissionId || entry.id === steered.submissionId,
				) ? undefined : true,
			);

			// The withdrawn submissions never run: the first answer ends the run.
			await waitFor("the answer", () =>
				entries(state.view).some((entry) => messageText(entry) === "Slow command finished.") ? true : undefined,
			);
			await waitFor("idle", () => (state.agentStatus?.busy === false ? true : undefined));
			assert.equal(
				entries(state.view).filter((entry) => entry.kind === "pi.user").length,
				1,
				"the withdrawn follow-up was never placed",
			);
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
				entries(state.view).some(
					(entry) =>
						entry.kind === "pi.assistant" &&
						(entry.model?.[0] as { stopReason?: string } | undefined)?.stopReason === "error",
				)
					? true
					: undefined,
			);
			await waitFor("idle after the failure", () => (state.agentStatus?.busy === false ? true : undefined));
			assert.deepEqual(
				inboxItems(state.view).map((item) => ({ id: item.id, mode: item.mode })),
				[{ id: queued.submissionId, mode: "followUp" }],
			);
			assert.equal(live(state.view)?.run, undefined);

			// A queued submission stays the durable backend's to take back while the agent sits dead.
			await agent.withdrawSubmission({ submissionId: queued.submissionId });
			await waitFor("the withdrawn item", () =>
				inboxItems(state.view).some((entry) => entry.id === queued.submissionId) ? undefined : true,
			);
		} finally {
			if (previous === undefined) delete process.env.PDA_RUN_RETRY_ATTEMPTS;
			else process.env.PDA_RUN_RETRY_ATTEMPTS = previous;
			await client.close();
		}
	});

	it("drains a queue that waited out a failed run once the provider is back", async () => {
		const previous = process.env.PDA_RUN_RETRY_ATTEMPTS;
		process.env.PDA_RUN_RETRY_ATTEMPTS = "0"; // the manual hook fire plays the provider coming back
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
				// The provider is back: the resumed runs answer each waiting submission in turn, one per
				// final boundary (`steeringMode`/`followUpMode` default to one-at-a-time), the retry hook last.
				fauxAssistantMessage(fauxText("Back on. First queued wish done.")),
				fauxAssistantMessage(fauxText("Second queued wish done.")),
				fauxAssistantMessage(fauxText("Resumed from the failure.")),
			]);

			await agent.submit({ content: "Fail for me." });
			const first = await agent.submit({ content: "First wish.", whenBusy: "followUp" });
			const second = await agent.submit({ content: "Second wish.", whenBusy: "followUp" });

			await waitFor("the run to fail", () => (state.agentStatus?.busy === false ? true : undefined));
			await waitFor("both submissions still queued", () => {
				const ids = inboxItems(state.view).map((item) => item.id);
				return ids.length === 2 &&
					[...ids].sort((a, b) => a - b).join(",") ===
						[first.submissionId, second.submissionId].sort((a, b) => a - b).join(",")
					? true
					: undefined;
			});

			// The same hook the server's supervisor fires on its own schedule: the queue drains one submission
			// per final boundary, then the hook input runs.
			await agent.fireHook({ hookId: RETRY_HOOK_ID, payload: "usage limit reached" });
			await waitFor("the first queued answer", () =>
				entries(state.view).some((entry) => messageText(entry) === "Back on. First queued wish done.")
					? true
					: undefined,
			);
			await waitFor("the second queued answer", () =>
				entries(state.view).some((entry) => messageText(entry) === "Second queued wish done.") ? true : undefined,
			);
			await waitFor("the hook's own answer", () =>
				entries(state.view).some((entry) => messageText(entry) === "Resumed from the failure.") ? true : undefined,
			);
			await waitFor("idle, queue empty", () =>
				state.agentStatus?.busy === false && inboxItems(state.view).length === 0 ? true : undefined,
			);
			assert.equal(entries(state.view).filter((entry) => entry.kind === "app.hook").length, 1);
			assert.equal(
				entries(state.view).filter((entry) => entry.kind === "pi.user").length,
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
			await waitFor("running tools", () =>
				state.agentStatus?.runStatus === "running_tools" ? true : undefined,
			);

			await agent.abort();
			await waitFor("idle after the abort", () =>
				state.agentStatus?.runStatus === "idle" ? true : undefined,
			);
			assert.equal(
				entries(state.view).filter((entry) => entry.kind === "pi.assistant" && messageText(entry) !== "").length,
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
			await waitFor("the initial view", () => state.view);
			// The threshold is measured against the usage of the previous request, so a first turn records it.
			client.faux.setResponses([fauxAssistantMessage(fauxText("Hello there."))]);
			await agent.submit({ content: "Hello" });
			await waitFor("the first answer", () =>
				(state.view?.entries ?? []).some((entry) => entry.kind === "pi.assistant") ? true : undefined,
			);
			// Second response is the summary the compaction task asks for, third the answer to the second prompt.
			client.faux.setResponses([
				fauxAssistantMessage(fauxText("Compressed history: the user greeted the agent.")),
				fauxAssistantMessage(fauxText("Answer after compaction.")),
			]);
			await agent.submit({ content: "Hello again" });
			const compaction = await waitFor("a compaction entry", () =>
				(state.view?.entries ?? []).find((entry) => entry.kind === "pi.compaction"),
			);
			assert.ok(
				["threshold", "overflow"].includes((compaction.data as { reason?: string } | undefined)?.reason ?? ""),
				`reason: ${JSON.stringify(compaction.data)}`,
			);
			// Compaction replaces the compacted span, so the check is on the answer's text, not on a count.
			await waitFor("the second answer", () =>
				(state.view?.entries ?? []).some(
					(entry) =>
						entry.kind === "pi.assistant" &&
						((entry.model?.[0] as { content?: { type: string; text?: string }[] } | undefined)?.content ?? []).some(
							(part) => part.type === "text" && part.text === "Answer after compaction.",
						),
				)
					? true
					: undefined,
			);
		} finally {
			client.agent.release();
		}
	});

	it("fires a hook from the client and from the webhook endpoint", async () => {
		const client = await openClient();
		const { agent, state } = client;
		try {
			await agent.ready;
			client.faux.setResponses([
				fauxAssistantMessage(fauxText("Proactive check done.")),
				fauxAssistantMessage(fauxText("Webhook check done.")),
			]);
			await agent.fireHook({ hookId: "workspace-check" });
			const hookEntry = await waitFor("the hook entry", () =>
				entries(state.view).find((entry) => entry.kind === "app.hook"),
			);
			assert.equal((hookEntry.data as { hookName: string }).hookName, "Workspace check");
			await waitFor("the proactive answer", () =>
				entries(state.view).some((entry) => messageText(entry) === "Proactive check done.") ? true : undefined,
			);
			await waitFor("the hook counter", () =>
				state.agentStatus?.hooks.find((hook) => hook.id === "workspace-check")?.fireCount === 1 ? true : undefined,
			);

			// An external script or timer wakes the agent through HTTP.
			const response = await fetch(`http://127.0.0.1:${client.server.port}/api/hooks/morning-brief/fire`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: "the build is red" }),
			});
			assert.equal(response.status, 200);
			const body = (await response.json()) as { submissionId: number };
			assert.equal(typeof body.submissionId, "number");
			await waitFor("the webhook answer", () =>
				entries(state.view).some((entry) => messageText(entry) === "Webhook check done.") ? true : undefined,
			);
			const webhook = entries(state.view).find((entry) => entry.kind === "app.hook" && messageText(entry).includes("the build is red"));
			assert.ok(webhook, "the webhook payload reaches the agent");
		} finally {
			await client.close();
		}
	});

	it("enables the sandboxed-UI tool and settles a generateSandboxedUi call", async () => {
		const client = await openClient();
		const { agent, state } = client;
		try {
			await agent.ready;
			await waitFor("the initial view", () => state.view);
			assert.equal(state.agentStatus?.sandboxedUiEnabled, false);
			assert.equal(
				sections(state.view).some((section) => "generative_ui" in section),
				false,
				"the widget prompt is off until the toggle",
			);

			await agent.setSandboxedUiEnabled({ enabled: true });
			await waitFor("the toggle", () => (state.agentStatus?.sandboxedUiEnabled ? true : undefined));

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
				live(state.view)?.tools?.find((entry) => entry.name === "generateSandboxedUi"),
			);
			assert.ok(["pending", "running", "done"].includes(slot.status));

			await waitFor("the widget tool result", () =>
				entries(state.view).some(
					(entry) => entry.kind === "pi.tool-result" && (entry.model?.[0] as { toolName?: string }).toolName === "generateSandboxedUi",
				) ? true : undefined,
			);
			await waitFor("the answer", () =>
				entries(state.view).some((entry) => messageText(entry) === "Here is the widget.") ? true : undefined,
			);

			// What the renderer reads: the settled arguments of the tool call in the assistant entry.
			const call = entries(state.view)
				.flatMap((entry) => (entry.kind === "pi.assistant" ? (entry.model?.[0] as { content?: unknown[] }).content ?? [] : []))
				.find((part) => (part as { name?: string }).name === "generateSandboxedUi") as
				| { arguments: { css?: string; html?: string[]; jsExpressions?: string[] } }
				| undefined;
			assert.equal(call?.arguments.css, "body{font:14px system-ui}");
			assert.deepEqual(call?.arguments.html, ["<div id='w'>widget</div>"]);
			assert.deepEqual(call?.arguments.jsExpressions, ["boot()"]);

			// The prompt section is in effect for the next request of this conversation.
			assert.ok(sections(state.view).some((section) => "generative_ui" in section));
		} finally {
			await client.close();
		}
	});
});
