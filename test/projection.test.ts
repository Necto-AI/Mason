/**
 * The wire boundary: what the reader is sent, and what stays on the server.
 *
 * These are the tests that keep the privacy property honest. A transcript item exists only because `projection.ts`
 * names it, so every case here asserts both halves: the thing the reader needs arrives, and the machine's working
 * notes — reasoning, tool arguments, tool output, entries — do not. A new tool or entry kind cannot leak by default;
 * if one of these passes with a leak, the whitelist was widened by accident.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { MESSAGE_TOOL } from "../src/shared/contract.ts";
import { projectQueued, projectTranscript } from "../src/server/projection.ts";
import { workingLabel } from "../src/web/lib/working.ts";

type Entry = Record<string, unknown>;

/** A view built from entries, the way pi-durable hands one to the server. */
function viewOf(entries: Entry[], docs: Record<string, unknown> = {}): ConversationView {
	return { conversation: { id: 1 }, entries, docs } as unknown as ConversationView;
}

function entry(id: number, kind: string, model: unknown[], extra: Record<string, unknown> = {}): Entry {
	return { id, kind, model, ...extra };
}

function assistant(id: number, content: unknown[], extra: Record<string, unknown> = {}): Entry {
	return entry(id, "pi.assistant", [{ role: "assistant", content, ...extra }]);
}

function call(name: string, args: Record<string, unknown>, id: string) {
	return { type: "toolCall", id, name, arguments: args };
}

function result(id: number, toolCallId: string, text: string, isError = false): Entry {
	return entry(id, "pi.tool-result", [{ role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError }]);
}

describe("the transcript the client is sent", () => {
	it("carries the reader's words and the message the agent sent, and nothing else", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Check the deploy." }]),
				entry(2, "pi.system", [{ role: "system", content: "", toolsAdded: [{ name: "send_to_user" }] }]),
				assistant(3, [
					{ type: "thinking", thinking: "The token is hunter2." },
					call("bash", { command: "curl -H 'authorization: Bearer hunter2' example.invalid" }, "leaky"),
					{ type: "text", text: "Working notes, not a message." },
				]),
				result(4, "leaky", "response included hunter2", false),
				assistant(5, [{ type: "text", text: "Notes again." }, call(MESSAGE_TOOL, { message: "The deploy is healthy." }, "sent")]),
				result(6, "sent", "delivered", false),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Check the deploy." },
			{ kind: "delivered", id: "sent", text: "The deploy is healthy." },
		]);
		// The property, said once over the whole payload: no secret, no reasoning, no call.
		const wire = JSON.stringify(transcript);
		assert.ok(!wire.includes("hunter2"), "no tool argument or output crosses the wire");
		assert.ok(!wire.includes("thinking"), "no reasoning crosses the wire");
		assert.ok(!wire.includes("toolCall"), "no tool call crosses the wire");
		assert.ok(!wire.includes("Working notes"), "no assistant prose crosses the wire");
	});

	it("keeps a message whose result failed, and says it may not have arrived", () => {
		const transcript = projectTranscript(
			viewOf([
				assistant(1, [call(MESSAGE_TOOL, { message: "Standup moved." }, "m1")]),
				result(2, "m1", "interrupted", true),
			]),
		);
		assert.deepEqual(transcript, [{ kind: "delivered", id: "m1", text: "Standup moved.", failed: true }]);
	});

	it("drops a message with nothing in it rather than rendering an empty bubble", () => {
		const transcript = projectTranscript(
			viewOf([
				assistant(1, [call(MESSAGE_TOOL, { message: "   " }, "blank")]),
				assistant(2, [call(MESSAGE_TOOL, { message: "\u200b" }, "zero-width")]),
				assistant(3, [call(MESSAGE_TOOL, {}, "missing")]),
			]),
		);
		assert.deepEqual(transcript, []);
	});

	it("leaves no row for a trigger: a proactive turn is the message it sent", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "app.hook", [{ role: "user", content: "[EVENT HOOK: Morning brief]" }], {
					data: { hookId: "morning-brief", hookName: "Morning brief", firedAt: "2026-10-20T09:00:00.000Z", payload: "go" },
				}),
				assistant(2, [call(MESSAGE_TOOL, { message: "Morning: three things need you." }, "m1")]),
				result(3, "m1", "delivered"),
			]),
		);
		assert.deepEqual(transcript, [{ kind: "delivered", id: "m1", text: "Morning: three things need you." }]);
		// The schedule, its payload and the prompt it built stay on the server.
		const wire = JSON.stringify(transcript);
		for (const leak of ["Morning brief", "app.hook", "EVENT HOOK", "firedAt"]) {
			assert.ok(!wire.includes(leak), `the trigger's ${leak} does not reach the reader`);
		}
	});

	it("sends a widget as the artifact it is, never as the call that built it", () => {
		const transcript = projectTranscript(
			viewOf([
				assistant(1, [
					call("generateSandboxedUi", { html: ["<p>hello</p>"], jsFunctions: "() => hunter2" }, "w1"),
				]),
				result(2, "w1", "rendered", false),
			]),
		);
		assert.equal(transcript.length, 1);
		const widget = transcript[0] as { kind: string; content: Record<string, unknown>; streaming: boolean };
		assert.equal(widget.kind, "widget");
		assert.equal(widget.streaming, false);
		assert.deepEqual(widget.content.html, ["<p>hello</p>"]);
		// The mapper takes the artifact's own fields; nothing of the call's shape survives.
		assert.ok(!JSON.stringify(widget).includes("toolCall"));
	});

	it("says a run failed without the machine's reason", () => {
		const transcript = projectTranscript(
			viewOf([
				assistant(1, [{ type: "text", text: "partial" }], { stopReason: "error", errorMessage: "usage limit reached" }),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "notice", id: "failed:1", text: "Something went wrong, and the turn did not finish." },
		]);
		assert.ok(!JSON.stringify(transcript).includes("usage limit"), "the reason stays on the server");
	});

	it("streams the message of the round in flight, and does not repeat it once committed", () => {
		const streaming = projectTranscript(
			viewOf([], {
				"pi.live": { generation: { attempt: 1, message: { role: "assistant", content: [call(MESSAGE_TOOL, { message: "Half a sen" }, "m1")] } } },
			}),
		);
		assert.deepEqual(streaming, [{ kind: "delivered", id: "m1", text: "Half a sen", streaming: true }]);

		// The same call, now committed with its result: one item, not two.
		const committed = projectTranscript(
			viewOf(
				[assistant(1, [call(MESSAGE_TOOL, { message: "Half a sentence." }, "m1")]), result(2, "m1", "delivered")],
				{
					"pi.live": { generation: { attempt: 1, message: { role: "assistant", content: [call(MESSAGE_TOOL, { message: "Half a sentence." }, "m1")] } } },
				},
			),
		);
		assert.deepEqual(committed, [{ kind: "delivered", id: "m1", text: "Half a sentence." }]);
	});

	it("sends nothing at all for a turn that only worked", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Do the thing." }]),
				assistant(2, [{ type: "thinking", thinking: "planning" }, call("bash", { command: "ls" }, "c1")]),
				result(3, "c1", "file.txt"),
				assistant(4, [{ type: "text", text: "Done, nothing to report." }]),
			]),
		);
		assert.deepEqual(transcript, [{ kind: "user", id: "1", text: "Do the thing." }]);
	});
});

describe("the queue the client is sent", () => {
	it("labels a submission with the reader's own words, or the hook it becomes", () => {
		const queued = projectQueued(
			viewOf([], {
				"pi.inbox": {
					items: [
						{ id: 7, mode: "followUp", content: "Then check the logs." },
						{ id: 8, mode: "steer", content: [{ type: "text", text: "Also stderr." }] },
						{ id: 9, mode: "write", entry: { kind: "app.hook", data: { hookName: "Morning brief" } } },
					],
				},
			}),
		);
		assert.deepEqual(queued, [
			{ id: 7, mode: "followUp", text: "Then check the logs.", withdrawable: true },
			{ id: 8, mode: "steer", text: "Also stderr.", withdrawable: true },
			// An input that becomes a hook trigger is the inbox's once it knows its entry: there is nothing to take back.
			{ id: 9, mode: "write", text: "hook: Morning brief", withdrawable: false },
		]);
	});

	it("marks an input the inbox already turned into an entry as no longer withdrawable", () => {
		const queued = projectQueued(
			viewOf([], { "pi.inbox": { items: [{ id: 7, mode: "followUp", content: "done", entry: { kind: "pi.user" } }] } }),
		);
		assert.equal(queued[0]?.withdrawable, false);
	});
});

describe("the working line", () => {
	const status = (patch: Record<string, unknown>) =>
		({ runStatus: "idle", busy: false, runningTools: [], sandboxedUiEnabled: false, hooks: [], ...patch }) as never;

	it("names the tools of the running round and nothing else about them", () => {
		assert.equal(workingLabel(status({ runStatus: "running_tools", busy: true, runningTools: ["bash"] })), "working: bash");
		assert.equal(
			workingLabel(status({ runStatus: "running_tools", busy: true, runningTools: ["bash", "edit"] })),
			"working: bash, edit",
		);
	});

	it("says what stage it is in when no tool is running, and nothing at all when idle", () => {
		assert.equal(workingLabel(status({ runStatus: "generating", busy: true })), "working");
		assert.equal(workingLabel(status({ runStatus: "compacting", busy: true })), "compacting context");
		assert.equal(workingLabel(status({ runStatus: "retrying", busy: true })), "retrying");
		assert.equal(workingLabel(status({ runStatus: "idle", busy: true })), "working");
		assert.equal(workingLabel(status({})), undefined);
		assert.equal(workingLabel(undefined), undefined);
	});
});
