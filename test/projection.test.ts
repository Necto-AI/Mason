/**
 * The wire boundary: what the reader is sent, and what stays on the server.
 *
 * These are the tests that keep the privacy property honest. A transcript item exists only because `projection.ts`
 * names it, so every case here asserts both halves: the thing the reader needs arrives, and the machine's working
 * notes — reasoning, tool arguments, tool output, entries — do not. A new tool or entry kind cannot leak by default;
 * if one of these passes with a leak, the whitelist was widened by accident.
 *
 * The message itself is the one thing that changed shape: what the model writes is the agent's message, projected from
 * the assistant generation that carried it. There is no tool call whose entry is the delivery any more, and an older
 * home's `app.reply` entry still reads as the message it was.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { TranscriptItem as WireRow } from "mason-protocol";
import { projectQueued, projectTranscript } from "../src/server/projection.ts";
import {
	CONNECTOR_ENTRY_KIND,
	HOOK_ENTRY_KIND,
	REFLECTION_ASK,
	REPLY_ENTRY_KIND,
	splitAuthor,
	type TranscriptItem,
} from "../src/shared/contract.ts";

type Entry = Record<string, unknown>;

/**
 * The two spellings are one shape, checked at compile time.
 *
 * `packages/protocol` restates the transcript row because the wire validates it, and mason's projection writes it. This
 * assertion is what makes "typed against both spellings" true: a field added on one side and not the other fails
 * `npm run typecheck` here rather than becoming a row a client silently drops.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameSpelling: Same<TranscriptItem, WireRow> = true;

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

/** One message an older build committed, as its `app.reply` entry holds it: read, never written. */
function replyEntry(id: number, deliveryId: string, text: string, extra: Record<string, unknown> = {}): Entry {
	return entry(id, REPLY_ENTRY_KIND, [], { data: { deliveryId, blocks: [{ type: "text", text }], ...extra } });
}

describe("the transcript the client is sent", () => {
	it("carries the reader's words and one message per generation, and nothing else", () => {
		assert.equal(sameSpelling, true, "the projection's row and the wire's schema are the same shape");
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Check the deploy." }]),
				entry(2, "pi.system", [{ role: "system", content: "", toolsAdded: [{ name: "bash" }] }]),
				assistant(
					3,
					[
						{ type: "thinking", thinking: "The token is hunter2." },
						call("bash", { command: "curl -H 'authorization: Bearer hunter2' example.invalid" }, "leaky"),
						{ type: "text", text: "Checking the deploy now." },
					],
					{ stopReason: "toolUse" },
				),
				result(4, "leaky", "response included hunter2", false),
				assistant(5, [{ type: "text", text: "The deploy is healthy." }], { stopReason: "stop" }),
				result(6, "leaky", "delivered", false),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Check the deploy." },
			// One row per generation: the tool round's preface is a message too, and so is the answer that closed it.
			{ kind: "delivered", id: "message:1", text: "Checking the deploy now.", runId: "1" },
			{ kind: "delivered", id: "message:2", text: "The deploy is healthy.", runId: "1" },
		]);
		// The property, said once over the whole payload: no secret, no reasoning, no call.
		const wire = JSON.stringify(transcript);
		assert.ok(!wire.includes("hunter2"), "no tool argument or output crosses the wire");
		assert.ok(!wire.includes("thinking"), "no reasoning crosses the wire");
		assert.ok(!wire.includes("toolCall"), "no tool call crosses the wire");
		assert.ok(!wire.includes("pi.system"), "no entry kind crosses the wire");
	});

	it("drops a message with nothing in it rather than rendering an empty bubble", () => {
		const transcript = projectTranscript(
			viewOf([
				assistant(1, [{ type: "text", text: "   " }], { stopReason: "stop" }),
				assistant(2, [{ type: "text", text: "\u200b" }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, []);
	});

	it("leaves no row for a routine's trigger: a proactive turn is the message it wrote", () => {
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
				assistant(2, [{ type: "text", text: "Morning: three things need you." }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "delivered", id: "message:1", text: "Morning: three things need you.", runId: "1" },
		]);
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
						origin: { connector: "telegram", ref: "-1001234" },
					},
				}),
				assistant(2, [{ type: "text", text: "Nothing until Thursday." }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "what is on my calendar" },
			{ kind: "delivered", id: "message:1", text: "Nothing until Thursday.", runId: "1" },
		]);
		// The origin is provenance for the submission, not something the reader is shown or a row carries.
		assert.ok(!JSON.stringify(transcript).includes("telegram"));
	});

	it("leaves no row for a command a chat asked for, or for a compaction", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "app.command", [], { data: { command: "stop", requestId: "telegram:42" } }),
				entry(2, "pi.compaction", [{ role: "user", content: "Summary so far: the deadline moved." }]),
				assistant(3, [{ type: "text", text: "Stopped." }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, [{ kind: "delivered", id: "message:1", text: "Stopped." }]);
		// The command that started it, who asked, and the summary that replaced older turns stay on the server.
		const wire = JSON.stringify(transcript);
		for (const leak of ["app.command", "telegram:42", "compaction", "deadline moved"]) {
			assert.ok(!wire.includes(leak), `${leak} does not reach the reader`);
		}
	});

	it("marks a failed run's messages, and keeps the machine's reason", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Write the report." }]),
				assistant(2, [{ type: "text", text: "First section." }], { stopReason: "stop" }),
				assistant(3, [{ type: "text", text: "partial" }], {
					stopReason: "error",
					errorMessage: "usage limit reached",
				}),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Write the report." },
			{ kind: "delivered", id: "message:1", text: "First section.", runId: "1", failed: true },
			{ kind: "delivered", id: "message:2", text: "partial", runId: "1", failed: true },
			{ kind: "notice", id: "failed:3", text: "Something went wrong, and the turn did not finish." },
		]);
		assert.ok(!JSON.stringify(transcript).includes("usage limit"), "the reason stays on the server");
	});

	it("keeps a failed run with no message to one notice, inside the turn it belongs to", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Write the report." }]),
				assistant(2, [{ type: "thinking", thinking: "planning" }], {
					stopReason: "error",
					errorMessage: "usage limit reached",
				}),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Write the report." },
			{ kind: "notice", id: "failed:2", text: "Something went wrong, and the turn did not finish." },
		]);
	});

	it("does not mark a retry's message failed, and does not duplicate the failed row", () => {
		// The failed run's turn ends with an error; the retry fires a hook (a turn of its own) and answers in it.
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Write the report." }]),
				assistant(2, [{ type: "text", text: "partial" }], { stopReason: "error" }),
				entry(3, HOOK_ENTRY_KIND, [{ role: "user", content: "[EVENT: retry]" }], {
					data: { hookId: "retry-failed-run", hookName: "Retry a failed run" },
				}),
				assistant(4, [{ type: "text", text: "The report, finished." }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Write the report." },
			{ kind: "delivered", id: "message:1", text: "partial", runId: "1", failed: true },
			{ kind: "notice", id: "failed:2", text: "Something went wrong, and the turn did not finish." },
			{ kind: "delivered", id: "message:2", text: "The report, finished.", runId: "3" },
		]);
	});

	it("reads an older home's committed reply as the message it was, under the id it was written with", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "Check the deploy." }]),
				replyEntry(2, "reply:call-1", "The deploy is healthy.", { origin: { connector: "telegram", ref: "x" } }),
				assistant(3, [{ type: "text", text: "And the migration too." }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Check the deploy." },
			{ kind: "delivered", id: "reply:call-1", text: "The deploy is healthy.", runId: "1" },
			{ kind: "delivered", id: "message:2", text: "And the migration too.", runId: "1" },
		]);
	});

	it("streams the message of the round in flight under the id it commits with", () => {
		const streaming = projectTranscript(
			viewOf([entry(1, "pi.user", [{ role: "user", content: "Anything new?" }])], {
				"pi.live": {
					generation: {
						attempt: 1,
						message: { role: "assistant", content: [{ type: "text", text: "Half a sen" }] },
					},
				},
			}),
		);
		assert.deepEqual(streaming, [
			{ kind: "user", id: "1", text: "Anything new?" },
			{ kind: "delivered", id: "message:1", text: "Half a sen", streaming: true, runId: "1" },
		]);

		// The entry has landed while the partial is still published: one row, not two, and it is the committed one.
		const committed = projectTranscript(
			viewOf([assistant(2, [{ type: "text", text: "Half a sentence." }], { stopReason: "stop" })], {
				"pi.live": {
					generation: {
						attempt: 1,
						message: { role: "assistant", content: [{ type: "text", text: "Half a sentence." }] },
					},
				},
			}),
		);
		assert.deepEqual(committed, [{ kind: "delivered", id: "message:1", text: "Half a sentence." }]);
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

	it("lets a routine's silent fire stay silent: a hook turn owes the reader nothing", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, HOOK_ENTRY_KIND, [{ role: "user", content: "[ROUTINE: Morning brief]" }], {
					data: { hookId: "morning-brief", hookName: "Morning brief", firedAt: "2026-10-20T09:00:00.000Z" },
				}),
				assistant(2, [{ type: "thinking", thinking: "nothing worth a message" }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, []);
	});

	it("shows the event a fire carried, and records no notice when it says nothing", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, HOOK_ENTRY_KIND, [{ role: "user", content: "a message arrived" }], {
					data: { hookId: "team-chat", hookName: "a chat message", kind: "chat.message" },
				}),
				assistant(2, [{ type: "thinking", thinking: "nothing to answer" }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, [{ kind: "event", id: "1", name: "chat.message" }]);
	});

	it("says the agent finished without a message, rather than leaving a submission blank", () => {
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
			{ kind: "notice", id: "silent:2", text: "The agent finished without writing you a message." },
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
				assistant(4, [{ type: "text", text: "Kept two lines." }], { stopReason: "stop" }),
				assistant(5, [{ type: "text", text: "Nothing else to report." }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(transcript, [
			{ kind: "user", id: "1", text: "Migrate the notes while I am out." },
			{ kind: "user", id: "2", text: "[reflection] That was a big one, anything to keep?" },
			// The second line is a person's own words, so it starts a turn of its own: the run is that message.
			{ kind: "delivered", id: "message:1", text: "Kept two lines.", runId: "2" },
			{ kind: "delivered", id: "message:2", text: "Nothing else to report.", runId: "2" },
		]);
	});

	it("starts a new run at each submission, so runId names the turn a message answers", () => {
		const transcript = projectTranscript(
			viewOf([
				entry(1, "pi.user", [{ role: "user", content: "One." }]),
				assistant(2, [{ type: "text", text: "First answer." }], { stopReason: "stop" }),
				entry(3, "pi.user", [{ role: "user", content: "Two." }]),
				assistant(4, [{ type: "text", text: "Second answer." }], { stopReason: "stop" }),
			]),
		);
		assert.deepEqual(
			transcript.flatMap((row) => (row.kind === "delivered" ? [row.runId] : [])),
			["1", "3"],
		);
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
