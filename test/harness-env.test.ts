/**
 * Milestone 1: the durable harness runs its tools through the `pi-env` daemon, event hooks make the
 * agent speak first, and a run interrupted by a restart picks up where it stopped.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, section, ToolResultEntry } from "@earendil-works/pi-durable";
import { openAgentRuntime, type AgentRuntime, type OpenAgentRuntimeOptions, type ResolvedModel } from "../src/server/runtime.ts";
import { projectTranscript } from "../src/server/projection.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

/** A faux provider whose scripted responses the test controls. */
function fauxAccess(): { access: ResolvedModel; faux: ReturnType<typeof fauxProvider> } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true }, faux };
}

function toolCall(name: string, args: JsonObject, id: string) {
	return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

function openFor(
	directory: string,
	access: ResolvedModel,
	options: { storage?: "sqlite" | "memory"; extensions?: OpenAgentRuntimeOptions["extensions"] } = {},
): Promise<AgentRuntime> {
	return openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		storage: options.storage ?? "sqlite",
		modelAccess: access,
		extensions: options.extensions,
		onReport: () => {},
	});
}

/** The transcript as the client receives it: the projection, not the entries behind it. */
async function readTranscript(runtime: AgentRuntime) {
	const view = await runtime.viewState(BACKGROUND_CONTEXT);
	try {
		return projectTranscript(view.value);
	} finally {
		view.dispose();
	}
}

async function readEntries(runtime: AgentRuntime) {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return [...page.items].reverse();
}

function textOf(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? "").join("");
	return "";
}

/** A `pi.system` entry carries the rendered prompt sections, not message content. */
function sectionsOf(message: unknown): Record<string, string | null> {
	return (message as { sections?: Record<string, string | null> } | undefined)?.sections ?? {};
}

describe("durable harness + pi-env", () => {
	it("runs write, edit, read, and bash through the pi-env daemon", async () => {
		const directory = await tempDir("pda-env-");
		await writeFile(join(directory, "SOUL.md"), "You are SOUL-MARKER, a test agent.\n");
		const { access, faux } = fauxAccess();
		faux.setResponses([
			toolCall("write", { path: "note.txt", content: "hello world\n" }, "w"),
			toolCall("edit", { path: "note.txt", edits: [{ oldText: "world", newText: "durable" }] }, "e"),
			toolCall("read", { path: "note.txt" }, "r"),
			toolCall("bash", { command: "wc -c < note.txt" }, "b"),
			fauxAssistantMessage(fauxText("The note greets durable.")),
		]);

		const runtime = await openFor(directory, access);
		try {
			const settled = await (
				await (await runtime.conversation()).submit({ type: "input", content: "Leave a note." }, BACKGROUND_CONTEXT)
			).wait(BACKGROUND_CONTEXT);
			assert.equal(settled.status, "done");

			// The file exists on the host only because the daemon executed the calls.
			assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "hello durable\n");

			const entries = await readEntries(runtime);
			const toolResults = entries.filter(ToolResultEntry.is);
			assert.deepEqual(
				toolResults.map((entry) => (entry.model?.[0] as { toolName?: string }).toolName),
				["write", "edit", "read", "bash"],
			);
			// The `read` result carries what the daemon returned, not what the model asked for.
			assert.match(textOf(toolResults[2]?.model?.[0]), /hello durable/);
			assert.equal(entries.filter((entry) => entry.kind === "pi.assistant").length, 5);

			// `SOUL.md` from the workspace and the working directory reach the system prompt.
			const system = entries
				.filter((entry) => entry.kind === "pi.system")
				.flatMap((entry) => Object.values(sectionsOf(entry.model?.[0])))
				.join("\n");
			assert.match(system, /SOUL-MARKER/);
			assert.ok(system.includes(directory), "the cwd section names the working directory");
		} finally {
			await runtime.close();
		}
	});

	it("send_to_user is offered in every conversation, and its call is the message the client renders", async () => {
		const directory = await tempDir("pda-deliver-");
		const { access, faux } = fauxAccess();
		faux.setResponses([
			toolCall("send_to_user", { message: "Standup moved to nine." }, "m1"),
			fauxAssistantMessage(fauxText("Nothing else to report.")),
		]);
		const runtime = await openFor(directory, access, { storage: "memory" });
		try {
			const submission = await (await runtime.conversation()).submit(
				{ type: "input", content: "Anything new?" },
				BACKGROUND_CONTEXT,
			);
			assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");

			const entries = await readEntries(runtime);
			// The call ran, so the tool was offered: it is in the base extension list, not behind a toggle.
			const result = entries
				.filter(ToolResultEntry.is)
				.find((entry) => (entry.model?.[0] as { toolName?: string }).toolName === "send_to_user");
			assert.ok(result, "the call reached the tool");
			assert.equal((result.model?.[0] as { isError?: boolean }).isError, false);
			assert.match(textOf(result.model?.[0]), /delivered/);

			// What leaves the server for the client is the reader's transcript: the message, and nothing of the working
			// notes beside it — no prose, no reasoning, no call.
			const transcript = await readTranscript(runtime);
			assert.deepEqual(
				transcript.filter((item) => item.kind !== "user"),
				[{ kind: "delivered", id: "m1", text: "Standup moved to nine." }],
			);

			// The invariant the client relies on is in the prompt, not just in the tool description.
			const system = entries
				.filter((entry) => entry.kind === "pi.system")
				.flatMap((entry) => Object.values(sectionsOf(entry.model?.[0])))
				.join("\n");
			assert.match(system, /Only messages sent via `send_to_user` are seen by the user/);
		} finally {
			await runtime.close();
		}
	});

	it("an event hook appends an app.hook entry and the agent answers on its own", async () => {
		const directory = await tempDir("pda-hook-");
		const { access, faux } = fauxAccess();
		// The proactive turn delivers through `send_to_user` like any other: a message, then a working note.
		faux.setResponses([
			toolCall("send_to_user", { message: "Workspace is clean." }, "h1"),
			fauxAssistantMessage(fauxText("Nothing else to report.")),
		]);
		const runtime = await openFor(directory, access, { storage: "memory" });
		try {
			assert.deepEqual(
				runtime.hooks.list().map((hook) => hook.id),
				["morning-brief", "retry-failed-run", "workspace-check"],
			);
			const submission = await runtime.hooks.fire("workspace-check");
			assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");

			const entries = await readEntries(runtime);
			const hookEntry = entries.find((entry) => entry.kind === "app.hook");
			assert.ok(hookEntry, "the proactive trigger is in the transcript");
			const data = hookEntry.data as { hookId: string; hookName: string; payload: null; firedAt: string };
			assert.equal(data.hookId, "workspace-check");
			assert.equal(data.hookName, "Workspace check");
			assert.equal(data.payload, null);
			assert.match(data.firedAt, /^\d{4}-\d{2}-\d{2}T/);
			assert.match(textOf(hookEntry.model?.[0]), /^\[EVENT HOOK: Workspace check\]/);

			// The hook input started a run, and the model's answer is the proactive message.
			const answers = entries.filter((entry) => entry.kind === "pi.assistant");
			assert.equal(answers.length, 2, "the delivered call, then the wrap-up");
			assert.match(textOf(answers[1]?.model?.[0]), /Nothing else to report\./);

			// What leaves the server for a proactive turn is the message, and not the trigger that produced it.
			const transcript = await readTranscript(runtime);
			assert.deepEqual(
				transcript.map((item) => item.kind),
				["delivered"],
			);
			assert.deepEqual(
				transcript.filter((item) => item.kind === "delivered").map((item) => (item as { text: string }).text),
				["Workspace is clean."],
			);

			const hook = runtime.hooks.get("workspace-check");
			assert.equal(hook?.fireCount, 1);
			assert.ok(hook?.lastFiredAt !== undefined);
		} finally {
			await runtime.close();
		}
	});

	it("the retry hook carries the failure back to the agent, and nothing schedules it on its own", async () => {
		const directory = await tempDir("pda-retry-");
		const { access, faux } = fauxAccess();
		faux.setResponses([fauxAssistantMessage(fauxText("Resuming the write."))]);
		const runtime = await openFor(directory, access, { storage: "memory" });
		try {
			const hook = runtime.hooks.get("retry-failed-run");
			assert.ok(hook, "the retry hook ships built in");
			// Manual only: an interval would fire it at a model that may still be down.
			assert.equal(hook.enabled, false);
			assert.equal((hook as { intervalMs?: number }).intervalMs, undefined);

			const submission = await runtime.hooks.fire("retry-failed-run", { payload: "Connection error." });
			assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");

			const entries = await readEntries(runtime);
			const hookEntry = entries.find((entry) => entry.kind === "app.hook");
			assert.ok(hookEntry);
			const data = hookEntry.data as { hookId: string; payload: string };
			assert.equal(data.hookId, "retry-failed-run");
			assert.equal(data.payload, "Connection error.");
			// The prompt tells the agent to resume rather than restart, with the failure in it.
			const prompt = textOf(hookEntry.model?.[0]);
			assert.match(prompt, /^\[EVENT HOOK: Retry a failed run\]/);
			assert.match(prompt, /resume it from where it stopped/i);
			assert.match(prompt, /Connection error\./);
		} finally {
			await runtime.close();
		}
	});

	it("resumes a run a restart interrupted and answers it", async () => {
		const directory = await tempDir("pda-recovery-");
		const blocked = deferred();
		let block = true;
		// A section that parks the generation until the "crash", so the run is provably unfinished.
		const Blocker = defineExtension({
			name: "test-blocker",
			sections: [
				section("test_block", async (_input, context: Context) => {
					if (block) {
						block = false;
						blocked.resolve();
						await aborted(context.abortSignal);
					}
					return undefined;
				}),
			],
		});

		const { access, faux } = fauxAccess();
		faux.setResponses([fauxAssistantMessage(fauxText("Never delivered."))]);
		const runtime = await openFor(directory, access, { extensions: [Blocker] });
		const submission = await (
			await runtime.conversation()
		).submit({ type: "input", content: "Work on it." }, BACKGROUND_CONTEXT);
		await blocked.promise;
		await runtime.close();

		const { access: restartedAccess, faux: restartedFaux } = fauxAccess();
		restartedFaux.setResponses([fauxAssistantMessage(fauxText("Finished after the restart."))]);
		const reopened = await openFor(directory, restartedAccess);
		try {
			const handle = await reopened.harness.submission(submission.id, withAbortSignal(AbortSignal.timeout(30_000), BACKGROUND_CONTEXT));
			assert.equal((await handle?.wait(BACKGROUND_CONTEXT))?.status, "done");

			const entries = await readEntries(reopened);
			assert.deepEqual(
				entries.map((entry) => entry.kind),
				["pi.user", "pi.system", "pi.assistant"],
			);
			assert.equal(textOf(entries.at(-1)?.model?.[0]), "Finished after the restart.");
		} finally {
			await reopened.close();
		}
	});
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
	if (signal === undefined || signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
