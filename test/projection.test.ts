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
import { projectQueued, projectTranscript } from "../src/server/projection.ts";
import {
	CONNECTOR_ENTRY_KIND,
	DELIVERY_ENTRY_KIND,
	REFLECTION_ASK,
	REPLY_ENTRY_KIND,
	REPLY_TOOL,
	splitAuthor,
} from "../src/shared/contract.ts";

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
	return entry(id, "pi.tool-result", [
		{ role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError },
	]);
}

/** One committed reply, as `reply` writes it: the entry is the delivery, not the call that asked for it. */
function replyEntry(id: number, deliveryId: string, text: string, extra: Record<string, unknown> = {}): Entry {
	return entry(id, REPLY_ENTRY_KIND, [], { data: { deliveryId, blocks: [{ type: "text", text }], ...extra } });
}

/** One acknowledgement, as the outbox records it. */
function ackEntry(id: number, deliveryId: string, status: string, detail?: string): Entry {
	return entry(id, DELIVERY_ENTRY_KIND, [], {
		data: { deliveryId, status, ...(detail === undefined ? {} : { detail }) },
	});
}

describe("the transcript the client is sent", () => {
	it("carries the reader's words and the message the agent sent, and nothing else", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Check the deploy." }]),
				entry(2, "pi.system", [{ role: "system", content: "", toolsAdded: [{ name: "reply" }] }]),
				assistant(3, [
					{ type: "thinking", thinking: "The token is hunter2." },
					call("bash", { command: "curl -H 'authorization: Bearer hunter2' example.invalid" }, "leaky"),
					{ type: "text", text: "Working notes, not a message." },
				]),
				result(4, "leaky", "response included hunter2", false),
				assistant(5, [
					{ type: "text", text: "Notes again." },
					call(REPLY_TOOL, { message: "The deploy is healthy." }, "sent"),
				]),
				result(6, "sent", "delivered", false),
				replyEntry(7, "reply:sent", "The deploy is healthy."),
				ackEntry(8, "reply:sent", "delivered"),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Check the deploy." },
			{ kind: "delivered", id: "reply:sent", text: "The deploy is healthy." },
		]);
		// The property, said once over the whole payload: no secret, no reasoning, no call.
		const wire = JSON.stringify(transcript);
		assert.ok(!wire.includes("hunter2"), "no tool argument or output crosses the wire");
		assert.ok(!wire.includes("thinking"), "no reasoning crosses the wire");
		assert.ok(!wire.includes("toolCall"), "no tool call crosses the wire");
		assert.ok(!wire.includes("Working notes"), "no assistant prose crosses the wire");
	});

	it("keeps a message whose delivery is uncertain, and says it may not have arrived", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Move standup." }]),
				replyEntry(2, "reply:m1", "Standup moved."),
				ackEntry(3, "reply:m1", "uncertain", "the vendor timed out after the send"),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Move standup." },
			{ kind: "delivered", id: "reply:m1", text: "Standup moved." },
			{
				kind: "notice",
				id: "delivery:reply:m1",
				text: "This message may not have reached the chat: the connector could not tell whether it was sent.",
			},
		]);
		// The connector's own sentence is data from outside: the reader gets the coarse line, not the vendor's words.
		assert.ok(!JSON.stringify(transcript).includes("vendor timed out"));
	});

	it("drops a message with nothing in it rather than rendering an empty bubble", () => {
		const transcript = projectTranscript(
			viewOf([replyEntry(1, "reply:blank", "   "), replyEntry(2, "reply:zero-width", "\u200b")]),
		);
		assert.deepEqual(transcript, []);
	});

	it("leaves no row for a trigger: a proactive turn is the message it sent", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "app.hook", [{ role: "user", content: "[ROUTINE: Morning brief]" }], {
					data: {
						hookId: "morning-brief",
						hookName: "Morning brief",
						firedAt: "2026-10-20T09:00:00.000Z",
						payload: "go",
					},
				}),
				replyEntry(2, "reply:m1", "Morning: three things need you."),
			]),
		);
		assert.deepEqual(transcript, [{ kind: "delivered", id: "reply:m1", text: "Morning: three things need you." }]);
		// The schedule, its payload and the prompt it built stay on the server.
		const wire = JSON.stringify(transcript);
		for (const leak of ["Morning brief", "app.hook", "ROUTINE:", "firedAt"]) {
			assert.ok(!wire.includes(leak), `the trigger's ${leak} does not reach the reader`);
		}
	});

	it("shows a person's words that arrived through a connector", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, CONNECTOR_ENTRY_KIND, [{ role: "user", content: "what is on my calendar" }], {
					data: {
						origin: { connector: "telegram", externalConversationId: "-1001234" },
					},
				}),
				replyEntry(2, "reply:m1", "Nothing until Thursday."),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "what is on my calendar" },
			{ kind: "delivered", id: "reply:m1", text: "Nothing until Thursday." },
		]);
		// The origin is where a reply goes, not something the reader is shown.
		assert.ok(!JSON.stringify(transcript).includes("telegram"));
	});

	it("leaves no row for a command a chat asked for, or for a compaction", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "app.command", [], { data: { command: "stop", requestId: "telegram:42" } }),
				entry(2, "pi.compaction", [{ role: "user", content: "Summary so far: the deadline moved." }]),
				replyEntry(3, "reply:m1", "Stopped."),
			]),
		);
		assert.deepEqual(transcript, [{ kind: "delivered", id: "reply:m1", text: "Stopped." }]);
		// The command that started it, who asked, and the summary that replaced older turns stay on the server.
		const wire = JSON.stringify(transcript);
		for (const leak of ["app.command", "telegram:42", "compaction", "deadline moved"]) {
			assert.ok(!wire.includes(leak), `${leak} does not reach the reader`);
		}
	});

	it("says a run failed without the machine's reason", () => {
		const transcript = projectTranscript(
			viewOf([
				assistant(1, [{ type: "text", text: "partial" }], {
					stopReason: "error",
					errorMessage: "usage limit reached",
				}),
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
				"pi.live": {
					generation: {
						attempt: 1,
						message: { role: "assistant", content: [call(REPLY_TOOL, { message: "Half a sen" }, "m1")] },
					},
				},
			}),
		);
		assert.deepEqual(streaming, [{ kind: "delivered", id: "reply:m1", text: "Half a sen", streaming: true }]);

		// The entry has landed while the call is still in flight: one item, not two, and it is the committed one.
		const committed = projectTranscript(
			viewOf([replyEntry(1, "reply:m1", "Half a sentence.")], {
				"pi.live": {
					generation: {
						attempt: 1,
						message: { role: "assistant", content: [call(REPLY_TOOL, { message: "Half a sentence." }, "m1")] },
					},
				},
			}),
		);
		assert.deepEqual(committed, [{ kind: "delivered", id: "reply:m1", text: "Half a sentence." }]);
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

	it("drops the reflection ask, and keeps a person's line that opens with the marker", () => {
		// Both halves of one rule: the gate's question is a user entry the model answers, so the reader must not see it,
		// and a line somebody actually typed is never dropped for looking like it. `[reflection]` is the tell, and the
		// sentence after it is what makes it the ask.
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Migrate the notes while I am out." }]),
				entry(2, "pi.user", [{ role: "user", content: "[reflection] That was a big one, anything to keep?" }]),
				entry(3, "pi.user", [{ role: "user", content: REFLECTION_ASK }]),
				assistant(
					4,
					[
						{ type: "text", text: "Kept: two lines in the log." },
						call(REPLY_TOOL, { message: "Kept two lines." }, "m1"),
					],
					{
						stopReason: "toolUse",
					},
				),
				result(5, "m1", "delivered"),
				replyEntry(6, "reply:m1", "Kept two lines."),
				assistant(7, [{ type: "text", text: "Nothing else to report." }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Migrate the notes while I am out." },
			{ kind: "user", id: "2", text: "[reflection] That was a big one, anything to keep?" },
			{ kind: "delivered", id: "reply:m1", text: "Kept two lines." },
		]);
	});

	it("does not call an answer that carries its own delivery silent", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Anything new?" }]),
				assistant(2, [{ type: "text", text: "Notes." }, call(REPLY_TOOL, { message: "Nothing new." }, "m1")], {
					stopReason: "toolUse",
				}),
				result(3, "m1", "delivered"),
				replyEntry(4, "reply:m1", "Nothing new."),
				assistant(5, [{ type: "text", text: "Nothing else to report." }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Anything new?" },
			{ kind: "delivered", id: "reply:m1", text: "Nothing new." },
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
			// A message written without a prefix has no author, and is not given one.
			{ kind: "user", id: "2", text: "Check the deploy." },
			// One conversation, two speakers: a shared transcript reads as a conversation, not as one voice.
			{ kind: "user", id: "3", text: "Then the alert thresholds.", author: "Denis" },
		]);
	});

	it("keeps a stored prefix as an author row, because the message was written with one", () => {
		// mason writes no prefix any more. A home from before the cutover has messages that do, and rewriting their text
		// at read time would change what somebody actually said (#126). It is read, and left alone.
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "[from Ilya] ship it" }]),
				// Anything that is not the prefix byte for byte is left alone: the text is what somebody typed.
				entry(2, "pi.user", [{ role: "user", content: "[from Ilya]is not the prefix" }]),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "ship it", author: "Ilya" },
			{ kind: "user", id: "2", text: "[from Ilya]is not the prefix" },
		]);
	});

	it("reads a prefix only at the start of the message, and keeps every other character", () => {
		// A leading space defeats a byte-exact match, so an indented line is text rather than a claim of authorship.
		assert.deepEqual(splitAuthor(" [from Ilya] ship it"), { text: " [from Ilya] ship it" });
		assert.deepEqual(splitAuthor("[from Ilya] ship it"), { text: "ship it", author: "Ilya" });
		assert.deepEqual(splitAuthor("[from Ilya] "), { text: "", author: "Ilya" });
		assert.deepEqual(splitAuthor("   ship it"), { text: "   ship it" });
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
			viewOf([], {
				"pi.inbox": { items: [{ id: 7, mode: "followUp", content: "done", entry: { kind: "pi.user" } }] },
			}),
		);
		assert.equal(queued[0]?.withdrawable, false);
	});
});
