import assert from "node:assert/strict";
import { test } from "node:test";
import { pinnedAfterScroll } from "../src/web/lib/follower.ts";
import { singleLine, stepDuration, summarizeArgs } from "../src/web/lib/tool-view.ts";
import {
	type Block,
	groupBubbles,
	groupEntries,
	pairToolResults,
	toolOutcomes,
	toolStatus,
	turnPieces,
} from "../src/web/lib/transcript-model.ts";
import type { EntryLike, MessageLike, ToolSlotLike } from "../src/web/view-types.ts";

// The pure core of the chat area: entry grouping, turn flattening, bubble pairing and the small formatters.
// Everything here crosses a module's interface — no DOM involved.

function entry(id: number, kind: string, message?: MessageLike, data?: Record<string, unknown>): EntryLike {
	return {
		id,
		kind,
		...(message === undefined ? {} : { model: [message] }),
		...(data === undefined ? {} : { data: data as EntryLike["data"] }),
	};
}

const assistant = (content: unknown[]): MessageLike => ({ role: "assistant", content: content as never });
const toolResult = (toolCallId: string, text: string, extra: Partial<MessageLike> = {}): MessageLike => ({
	role: "toolResult",
	toolCallId,
	toolName: "bash",
	content: [{ type: "text", text }],
	...extra,
} as MessageLike);

test("groupEntries folds assistant work into the turn a user message opened", () => {
	const entries: EntryLike[] = [
		entry(1, "pi.user", { role: "user", content: "hello" }),
		entry(2, "pi.assistant", assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }])),
		entry(3, "pi.tool-result", toolResult("t1", "ok")),
		entry(4, "pi.assistant", assistant([{ type: "text", text: "done" }])),
		entry(5, "pi.compaction", { role: "user", content: "summarised" }, { reason: "threshold" }),
		entry(6, "pi.user", { role: "user", content: "again" }),
		entry(7, "pi.assistant", assistant([{ type: "text", text: "sure" }])),
	];
	const blocks = groupEntries(entries);
	assert.deepEqual(
		blocks.map((block) => block.kind),
		["user", "turn", "note", "user", "turn"],
	);
	const turn = blocks[1];
	assert.equal(turn.kind, "turn");
	if (turn.kind !== "turn") return;
	assert.deepEqual(
		turn.turn.entries.map((item) => item.id),
		[2, 3, 4],
	);
	assert.equal(blocks[4].kind === "turn" ? blocks[4].turn.entries.length : 0, 1);
});

test("groupEntries keeps the positional system prompt inside the turn", () => {
	const entries: EntryLike[] = [
		entry(1, "pi.user", { role: "user", content: "hi" }),
		entry(2, "pi.system", { role: "system", content: "", sections: { instructions: "…" } }),
		entry(3, "pi.assistant", assistant([{ type: "text", text: "hello" }])),
	];
	const blocks = groupEntries(entries);
	assert.deepEqual(
		blocks.map((block) => block.kind),
		["user", "turn"],
	);
	const turn = blocks[1];
	assert.equal(turn.kind, "turn");
	if (turn.kind !== "turn") return;
	assert.deepEqual(
		turn.turn.entries.map((item) => item.id),
		[2, 3],
	);
});

test("a hook trigger opens its own block and the turn that answers it", () => {
	const entries: EntryLike[] = [
		entry(1, "app.hook", { role: "user", content: "[EVENT HOOK: workspace-check]\n…" }, { hookName: "workspace-check" }),
		entry(2, "pi.assistant", assistant([{ type: "text", text: "I looked at the workspace." }])),
	];
	const blocks = groupEntries(entries);
	assert.deepEqual(
		blocks.map((block) => block.kind),
		["hook", "turn"],
	);
});

test("groupEntries keeps a note between turns from opening a turn of its own", () => {
	const blocks = groupEntries([
		entry(1, "pi.user", { role: "user", content: "hi" }),
		entry(2, "app.unknown"),
	]);
	assert.deepEqual(
		blocks.map((block) => block.kind),
		["user", "note"],
	);
});

test("turnPieces flattens a turn into thinking, tool and text pieces in order", () => {
	const turn = {
		entries: [
			entry(
				2,
				"pi.assistant",
				assistant([
					{ type: "thinking", thinking: "hmm" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
				]),
			),
			entry(3, "pi.tool-result", toolResult("t1", "ok", { durationMs: 120 })),
			entry(4, "pi.assistant", assistant([{ type: "text", text: "done" }])),
		],
	};
	const pieces = turnPieces(turn, undefined, []);
	assert.deepEqual(
		pieces.map((piece) => piece.kind),
		["thinking", "toolCall", "toolResult", "text"],
	);
	const result = pieces[2];
	assert.equal(result.kind === "toolResult" ? result.duration : undefined, "0.1s");
	assert.equal(result.kind === "toolResult" ? result.status : undefined, "done");
});

test("turnPieces pairs a running slot with the call it belongs to and lists the rest as live rows", () => {
	const slots: ToolSlotLike[] = [
		{ callId: "t1", name: "bash", status: "running", output: "half…" },
		{ callId: "t9", name: "grep", status: "running", output: "match" },
	];
	const turn = {
		entries: [entry(2, "pi.assistant", assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }]))],
	};
	const pieces = turnPieces(turn, undefined, slots);
	assert.deepEqual(
		pieces.map((piece) => piece.kind),
		["toolCall", "toolLive"],
	);
	const call = pieces[0];
	assert.equal(call.kind === "toolCall" ? call.status : undefined, "running");
	assert.equal(call.kind === "toolCall" ? call.slot?.output : undefined, "half…");
	const live = pieces[1];
	assert.equal(live.kind === "toolLive" ? live.tool.name : undefined, "grep");
});

test("a widget call becomes a widget piece, not a tool row; an error keeps the row", () => {
	const call = { type: "toolCall", id: "w1", name: "generateSandboxedUi", arguments: { css: "body{}" } };
	const streaming = assistant([call]);
	const live = turnPieces(undefined, streaming, []);
	assert.deepEqual(
		live.map((piece) => piece.kind),
		["widget"],
	);
	assert.equal(live[0].kind === "widget" ? live[0].streaming : undefined, true);
	assert.deepEqual(live[0].kind === "widget" ? live[0].args : undefined, { css: "body{}" });

	// Once the call is committed the widget settles; debug mode keeps the row above the card.
	const settled = { entries: [entry(2, "pi.assistant", streaming)] };
	assert.equal(turnPieces(settled, undefined, [])[0].kind === "widget" ? (turnPieces(settled, undefined, [])[0] as { streaming: boolean }).streaming : undefined, false);
	assert.deepEqual(
		turnPieces(settled, undefined, [], { widgetRows: true }).map((piece) => piece.kind),
		["toolCall", "widget"],
	);

	// A widget whose call failed renders as a normal tool row (dropped in normal mode, shown in debug).
	const failed = {
		entries: [entry(2, "pi.assistant", streaming), entry(3, "pi.tool-result", toolResult("w1", "boom", { isError: true }))],
	};
	assert.deepEqual(
		turnPieces(failed, undefined, []).map((piece) => piece.kind),
		["toolCall", "toolResult"],
	);
});

test("nested calls attach to their parent row", () => {
	const turn = {
		entries: [entry(2, "pi.assistant", assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }]))],
	};
	const pieces = turnPieces(turn, undefined, [], {
		nested: [
			{
				callId: "t1/sub",
				name: "read",
				status: "running",
				parentCallId: "t1",
				arguments: { path: "/tmp/a" },
			},
		],
	});
	const call = pieces[0];
	assert.equal(call.kind === "toolCall" ? call.nested.length : undefined, 1);
	assert.equal(call.kind === "toolCall" ? call.nested[0].name : undefined, "read");
});

test("groupBubbles pairs a trace with the message it produced and splits on a message", () => {
	const turn = {
		entries: [
			entry(
				2,
				"pi.assistant",
				assistant([
					{ type: "text", text: "Let me check." },
					{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
				]),
			),
			entry(3, "pi.tool-result", toolResult("t1", "ok")),
			entry(4, "pi.assistant", assistant([{ type: "text", text: "Done." }])),
		],
	};
	const bubbles = groupBubbles(turnPieces(turn, undefined, []));
	assert.deepEqual(
		bubbles.map((bubble) => ({ trace: bubble.trace.map((piece) => piece.kind), text: bubble.text })),
		[
			{ trace: [], text: "Let me check." },
			{ trace: ["toolCall", "toolResult"], text: "Done." },
		],
	);
});

test("groupBubbles keeps a trailing trace out of the message's bubble", () => {
	const pieces = turnPieces(undefined, assistant([{ type: "text", text: "hi" }]), [
		{ callId: "t9", name: "bash", status: "running" },
	]);
	const bubbles = groupBubbles(pieces);
	assert.deepEqual(
		bubbles.map((bubble) => ({ trace: bubble.trace.length, text: bubble.text })),
		[
			{ trace: 0, text: "hi" },
			{ trace: 1, text: "" },
		],
	);
});

test("a widget is produced content: work after it opens a new bubble, text lands beside it", () => {
	const turn = {
		entries: [
			entry(
				2,
				"pi.assistant",
				assistant([
					{ type: "toolCall", id: "w1", name: "generateSandboxedUi", arguments: { css: "body{}" } },
					{ type: "text", text: "Here is the chart." },
					{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } },
				]),
			),
		],
	};
	const bubbles = groupBubbles(turnPieces(turn, undefined, [], { widgetRows: true }));
	assert.deepEqual(
		bubbles.map((bubble) => ({
			trace: bubble.trace.map((piece) => piece.kind),
			widgets: bubble.widgets.length,
			text: bubble.text,
		})),
		[
			{ trace: ["toolCall"], widgets: 1, text: "Here is the chart." },
			{ trace: ["toolCall"], widgets: 0, text: "" },
		],
	);
});

test("pairToolResults matches results to calls and hands back the orphans", () => {
	const pieces = turnPieces(
		{
			entries: [
				entry(2, "pi.assistant", assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: {} }])),
				entry(3, "pi.tool-result", toolResult("t1", "ok")),
				entry(4, "pi.tool-result", toolResult("gone", "from a compacted call")),
			],
		},
		undefined,
		[],
	);
	const { byCall, orphans } = pairToolResults(
		pieces.filter((piece): piece is Extract<(typeof pieces)[number], { kind: "toolCall" | "toolResult" }> =>
			piece.kind === "toolCall" || piece.kind === "toolResult",
		),
	);
	assert.equal(byCall.get("t1")?.toolCallId, "t1");
	assert.deepEqual(
		orphans.map((message) => message.toolCallId),
		["gone"],
	);
});

test("toolOutcomes reads the settled results of a conversation", () => {
	const outcomes = toolOutcomes([
		entry(1, "pi.tool-result", toolResult("t1", "ok", { durationMs: 1500 })),
		entry(2, "pi.tool-result", toolResult("t2", "boom", { isError: true })),
	]);
	assert.equal(outcomes.get("t1")?.text, "ok");
	assert.equal(outcomes.get("t1")?.durationMs, 1500);
	assert.equal(outcomes.get("t2")?.isError, true);
});

test("toolStatus prefers the settled result, then the live slot, then how far the message got", () => {
	assert.equal(toolStatus({ text: "ok", isError: false }, undefined, true), "done");
	assert.equal(toolStatus({ text: "boom", isError: true }, undefined, true), "error");
	assert.equal(toolStatus(undefined, { callId: "t", name: "bash", status: "running" }, true), "running");
	assert.equal(toolStatus(undefined, { callId: "t", name: "bash", status: "pending" }, false), "pending");
	assert.equal(toolStatus(undefined, undefined, true), "done");
	assert.equal(toolStatus(undefined, undefined, false), "pending");
});

test("a conversation that shrank after a compaction still groups by what is left", () => {
	const before = groupEntries([
		entry(1, "pi.user", { role: "user", content: "one" }),
		entry(2, "pi.assistant", assistant([{ type: "text", text: "a" }])),
		entry(3, "pi.user", { role: "user", content: "two" }),
		entry(4, "pi.assistant", assistant([{ type: "text", text: "b" }])),
	]);
	const after = groupEntries([
		entry(9, "pi.compaction", { role: "user", content: "summary" }, { reason: "threshold" }),
		entry(4, "pi.assistant", assistant([{ type: "text", text: "b" }])),
	]);
	assert.deepEqual(
		before.map((block: Block) => block.kind),
		["user", "turn", "user", "turn"],
	);
	assert.deepEqual(
		after.map((block: Block) => block.kind),
		["note", "turn"],
	);
});

test("stepDuration floors at a tenth and drops the decimal past ten seconds", () => {
	assert.equal(stepDuration(400), "0.4s");
	assert.equal(stepDuration(0), "0.1s");
	assert.equal(stepDuration(12_400), "12s");
});

test("summarizeArgs picks the interesting argument and keeps it to one line", () => {
	assert.equal(summarizeArgs({ command: "ls -la\nsecond line" }), "ls -la");
	assert.equal(summarizeArgs({ path: "/tmp/a.txt" }), "/tmp/a.txt");
	assert.equal(summarizeArgs({ pattern: "swapLive" }), "swapLive");
	assert.equal(summarizeArgs({ query: "weather" }), "weather");
	assert.equal(summarizeArgs("plain string"), "plain string");
	assert.equal(summarizeArgs({ count: 3 }), "");
	assert.equal(summarizeArgs(null), "");
});

test("singleLine truncates with an ellipsis", () => {
	assert.equal(singleLine("a".repeat(120)).length, 101);
	assert.equal(singleLine("\n\n  trimmed  \n"), "trimmed");
});

test("pinnedAfterScroll reads intent: up unpins, the end repins, shrinking is not intent", () => {
	const end = { top: 900, height: 1000 };
	// a reader moving up with the content unchanged leaves the end
	assert.equal(pinnedAfterScroll(true, end, { top: 899, height: 1000 }, false), false);
	// content shrinking lowers scrollTop on its own: not the reader
	assert.equal(pinnedAfterScroll(true, end, { top: 800, height: 900 }, false), true);
	// landing at the end repins
	assert.equal(pinnedAfterScroll(false, { top: 0, height: 1000 }, { top: 900, height: 1000 }, true), true);
	// moving down but not at the end keeps the state it had
	assert.equal(pinnedAfterScroll(true, { top: 100, height: 1000 }, { top: 200, height: 1000 }, false), true);
	assert.equal(pinnedAfterScroll(false, { top: 100, height: 1000 }, { top: 200, height: 1000 }, false), false);
});
