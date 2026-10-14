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

	it("an event hook appends an app.hook entry and the agent answers on its own", async () => {
		const directory = await tempDir("pda-hook-");
		const { access, faux } = fauxAccess();
		faux.setResponses([fauxAssistantMessage(fauxText("Workspace is clean."))]);
		const runtime = await openFor(directory, access, { storage: "memory" });
		try {
			assert.deepEqual(
				runtime.hooks.list().map((hook) => hook.id),
				["morning-brief", "workspace-check"],
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
			assert.equal(answers.length, 1);
			assert.match(textOf(answers[0]?.model?.[0]), /Workspace is clean\./);

			const hook = runtime.hooks.get("workspace-check");
			assert.equal(hook?.fireCount, 1);
			assert.ok(hook?.lastFiredAt !== undefined);
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
