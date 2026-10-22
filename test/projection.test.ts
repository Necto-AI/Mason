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
import { MESSAGE_TOOL, withAuthor, type AgentStatus } from "../src/shared/contract.ts";
import { projectQueued, projectTranscript } from "../src/server/projection.ts";
import { createWorkingMachine, TOOL_LABEL_HOLD_MS } from "../src/web/lib/working.ts";

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

	it("sends nothing for the round that only worked", () => {
		// A tool round in flight: the reader keeps watching the working dots, and the round's calls are not a message.
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Do the thing." }]),
				assistant(2, [{ type: "thinking", thinking: "planning" }, call("bash", { command: "ls" }, "c1")], {
					stopReason: "toolUse",
				}),
				result(3, "c1", "file.txt"),
			]),
		);
		assert.deepEqual(transcript, [{ kind: "user", id: "1", text: "Do the thing." }]);
	});

	it("says the agent finished without a message, rather than leaving the turn blank", () => {
		// The delivery gate already gave this turn a second chance. Saying so is the last thing between the reader and
		// a chat that looks like it is still thinking.
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "How many items are in notes.md?" }]),
				assistant(2, [{ type: "thinking", thinking: "I read it earlier." }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "How many items are in notes.md?" },
			{ kind: "notice", id: "silent:2", text: "The agent finished without sending you a message." },
		]);
		// The answer the model wrote is still working notes, not a message: the wire is unchanged.
		assert.ok(!JSON.stringify(transcript).includes("I read it earlier"));
	});

	it("does not call an answer that carries its own delivery silent", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Anything new?" }]),
				assistant(2, [{ type: "text", text: "Notes." }, call(MESSAGE_TOOL, { message: "Nothing new." }, "m1")], {
					stopReason: "toolUse",
				}),
				result(3, "m1", "delivered"),
				assistant(4, [{ type: "text", text: "Nothing else to report." }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Anything new?" },
			{ kind: "delivered", id: "m1", text: "Nothing new." },
		]);
	});
});

describe("who said it", () => {
	it("reads the author off the message the server wrote, and shows the words without it", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "[from Ilya] Ship the deploy." }]),
				entry(2, "pi.user", [{ role: "user", content: "Check the deploy." }]),
				entry(3, "pi.user", [{ role: "user", content: "[from Denis] Then the alert thresholds." }]),
			]),
		);
		assert.deepEqual(transcript, [
			// The prefix is the model's attribution, not the reader's text: it never reaches the bubble.
			{ kind: "user", id: "1", text: "Ship the deploy.", author: "Ilya" },
			// A message written before the roster existed has no author, and is not given one.
			{ kind: "user", id: "2", text: "Check the deploy." },
			// One conversation, two speakers: a shared transcript reads as a conversation, not as one voice.
			{ kind: "user", id: "3", text: "Then the alert thresholds.", author: "Denis" },
		]);
	});

	it("does not give an author to text the server did not prefix", () => {
		// An unnamed device — or any token client — can type a prefix itself. `submit` drops it, so what is stored can
		// only name an author the server wrote: the transcript cannot be made to say someone spoke who did not.
		assert.equal(withAuthor("[from Ilya] ship it", undefined), "ship it", "the typed prefix never reaches the entry");
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: withAuthor("[from Ilya] ship it", undefined) }]),
				// Anything that is not the prefix byte for byte is left alone: the text is what somebody typed.
				entry(2, "pi.user", [{ role: "user", content: withAuthor("[from Ilya]is not the prefix", undefined) }]),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "ship it" },
			{ kind: "user", id: "2", text: "[from Ilya]is not the prefix" },
		]);
	});

	it("drops a typed prefix where the message starts, and keeps every other character", () => {
		// A leading space is enough to defeat a byte-exact match, and a raw client can send one.
		assert.equal(withAuthor(" [from Ilya] ship it", undefined), "ship it");
		assert.equal(withAuthor("\n\t[from Ilya] ship it", undefined), "ship it");
		// A message that was only a claim is left with nothing: the projection skips a blank row, which is the honest
		// rendering of a line that said nothing once its title was taken away.
		assert.equal(withAuthor("[from Ilya] ", undefined), "");
		// Without a prefix nothing is trimmed, because the indentation is somebody's text.
		assert.equal(withAuthor("   ship it", undefined), "   ship it");
	});

	it("does not turn a bracket into an author", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Look at [from Ilya] this." }]),
				entry(2, "pi.user", [{ role: "user", content: "[draft] the release notes" }]),
				entry(3, "pi.user", [{ role: "user", content: "[from Ilya]is not the prefix" }]),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Look at [from Ilya] this." },
			{ kind: "user", id: "2", text: "[draft] the release notes" },
			// The trailing space is part of the prefix: without it the text was never rewritten by the server.
			{ kind: "user", id: "3", text: "[from Ilya]is not the prefix" },
		]);
	});

	it("keeps the author of a submission still in the queue", () => {
		const queued = projectQueued(
			viewOf([], {
				"pi.inbox": {
					items: [
						{ id: 7, mode: "followUp", content: "[from Ilya] Then check the logs." },
						{ id: 8, mode: "steer", content: [{ type: "text", text: "Also stderr." }] },
					],
				},
			}),
		);
		assert.deepEqual(queued, [
			{ id: 7, mode: "followUp", text: "Then check the logs.", author: "Ilya", withdrawable: true },
			// An unnamed device queues under no name, and the hook it becomes never had one.
			{ id: 8, mode: "steer", text: "Also stderr.", withdrawable: true },
		]);
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
	const status = (patch: Partial<AgentStatus>): AgentStatus => ({
		runStatus: "idle",
		busy: false,
		runningTools: [],
		hooks: [],
		...patch,
	});
	const started = (start = 1_000) => {
		const clock = { at: start };
		return { clock, machine: createWorkingMachine({ now: () => clock.at }) };
	};

	it("names the latest tool call of the round and nothing else about it", () => {
		const { machine } = started();
		assert.equal(machine.label(status({ runStatus: "running_tools", busy: true, runningTools: ["bash"] })), "working: bash");
		assert.equal(
			machine.label(status({ runStatus: "running_tools", busy: true, runningTools: ["bash", "edit"] })),
			"working: edit",
		);
	});

	it("keeps a tool that finished in milliseconds on the line long enough to read", () => {
		const { clock, machine } = started();
		const generating = status({ runStatus: "generating", busy: true });
		assert.equal(machine.label(status({ runStatus: "running_tools", busy: true, runningTools: ["bash"] })), "working: bash");
		clock.at += 30;
		// The tool returned after 30 ms; the reader still sees the name it has only just been shown.
		assert.equal(machine.label(generating), "working: bash");
		assert.equal(machine.holdRemainingMs(), TOOL_LABEL_HOLD_MS - 30);
		clock.at += TOOL_LABEL_HOLD_MS - 30;
		assert.equal(machine.label(generating), "working");
		assert.equal(machine.holdRemainingMs(), undefined);
	});

	it("forgets the tool as soon as the turn is not busy", () => {
		const { clock, machine } = started();
		machine.label(status({ runStatus: "running_tools", busy: true, runningTools: ["bash"] }));
		clock.at += 10;
		assert.equal(machine.label(status({ busy: false })), undefined);
		// The next turn starts from nothing, even inside the previous hold window.
		assert.equal(machine.label(status({ runStatus: "generating", busy: true })), "working");
	});

	it("replaces an earlier tool with the one that ran after it", () => {
		const { clock, machine } = started();
		machine.label(status({ runStatus: "running_tools", busy: true, runningTools: ["bash"] }));
		clock.at += 30;
		assert.equal(machine.label(status({ runStatus: "generating", busy: true })), "working: bash");
		clock.at += 30;
		assert.equal(machine.label(status({ runStatus: "running_tools", busy: true, runningTools: ["edit"] })), "working: edit");
		clock.at += 30;
		assert.equal(machine.label(status({ runStatus: "generating", busy: true })), "working: edit");
	});

	it("lets compacting and retrying outrank the remembered tool, and says what stage it is in otherwise", () => {
		const { clock, machine } = started();
		machine.label(status({ runStatus: "running_tools", busy: true, runningTools: ["bash"] }));
		clock.at += 10;
		assert.equal(machine.label(status({ runStatus: "compacting", busy: true })), "compacting context");
		assert.equal(machine.label(status({ runStatus: "retrying", busy: true })), "retrying");
		// A stage is later activity than the tool, so the old name does not come back after it.
		assert.equal(machine.label(status({ runStatus: "generating", busy: true })), "working");
		assert.equal(machine.label(status({ runStatus: "idle", busy: true })), "working");
		assert.equal(machine.label(status({})), undefined);
		assert.equal(machine.label(undefined), undefined);
	});
});
