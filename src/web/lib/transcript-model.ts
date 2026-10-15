/**
 * The transcript's pure structure, ported from apiary's `packages/web/src/turns.ts` and adapted to pi-durable's
 * `ConversationView`: entries grouped into user/hook turns and notes, a turn flattened into pieces at message
 * boundaries, and pieces grouped into the bubbles the view renders. Traces are temporary — a bubble pairs the
 * work with what it produced; the view drops the trace once the text arrives, and widget cards are the one
 * trace piece that survives settlement.
 */
import {
	type EntryLike,
	type JsonObject,
	type MessageLike,
	type NestedToolSlotLike,
	type ToolCallPart,
	type ToolResultMessageLike,
	type ToolSlotLike,
	blocksOf,
	entryMessage,
	isTextBlock,
	isThinkingBlock,
	isToolCall,
	textOf,
} from "../view-types.ts";
import { stepDuration, summarizeArgs } from "./tool-view.ts";

/** The tool whose calls render as widget cards instead of tool rows. */
export const WIDGET_TOOL = "generateSandboxedUi";

/** Entry kinds that belong to the assistant's turn; everything else is a boundary or a note. */
const TURN_KINDS: ReadonlySet<string> = new Set(["pi.assistant", "pi.tool-result", "pi.system"]);

/** A turn is everything the assistant did between two user messages or hook triggers. */
export interface Turn {
	entries: EntryLike[];
}

export type Block =
	| { kind: "user"; entry: EntryLike }
	| { kind: "hook"; entry: EntryLike }
	| { kind: "turn"; turn: Turn }
	| { kind: "note"; entry: EntryLike };

/** Group a conversation's entries into user messages, hook triggers, assistant turns and notes. */
export function groupEntries(entries: readonly EntryLike[]): Block[] {
	const blocks: Block[] = [];
	let turn: Turn | undefined;
	const flush = (): void => {
		if (turn !== undefined) blocks.push({ kind: "turn", turn });
		turn = undefined;
	};
	for (const entry of entries) {
		if (entry.kind === "pi.user") {
			flush();
			blocks.push({ kind: "user", entry });
			continue;
		}
		// A hook is a turn boundary too: the agent speaks first, with no user message before it.
		if (entry.kind === "app.hook") {
			flush();
			blocks.push({ kind: "hook", entry });
			continue;
		}
		// `pi.system` is the positional prompt marker landing between user and assistant in every request:
		// it must not flush a turn, or every turn would split in two.
		if (TURN_KINDS.has(entry.kind)) {
			turn ??= { entries: [] };
			turn.entries.push(entry);
			continue;
		}
		flush();
		blocks.push({ kind: "note", entry });
	}
	flush();
	return blocks;
}

/** The React key of a block: stable while a turn grows, so open `<details>` survive an append. */
export function blockKey(block: Block): string {
	if (block.kind === "turn") return `turn:${block.turn.entries[0]?.id ?? "?"}`;
	return `${block.kind}:${block.entry.id}`;
}

/** Errors the turn's answers reported, rendered as notes in place of a missing bubble. */
export function turnErrors(turn: Turn): string[] {
	const errors: string[] = [];
	for (const entry of turn.entries) {
		const message = entryMessage(entry) as { stopReason?: string; errorMessage?: string } | undefined;
		if (message?.stopReason === "error" && message.errorMessage !== undefined) errors.push(message.errorMessage);
	}
	return errors;
}

/* ---------- tool results ---------- */

export interface ToolOutcome {
	text: string;
	isError: boolean;
	durationMs?: number;
}

/** Every settled tool result of the conversation, keyed by the call it answered. */
export function toolOutcomes(entries: readonly EntryLike[]): Map<string, ToolOutcome> {
	const outcomes = new Map<string, ToolOutcome>();
	for (const entry of entries) {
		if (entry.kind !== "pi.tool-result") continue;
		for (const message of entry.model ?? []) {
			const result = message as ToolResultMessageLike;
			if (result.role !== "toolResult" || typeof result.toolCallId !== "string") continue;
			outcomes.set(result.toolCallId, {
				text: textOf(result),
				isError: result.isError === true,
				...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
			});
		}
	}
	return outcomes;
}

export type ToolStatus = "pending" | "running" | "done" | "error";

/** A row's state: the settled result wins, then the live slot, then how far the message got. */
export function toolStatus(
	outcome: ToolOutcome | undefined,
	slot: ToolSlotLike | undefined,
	settled: boolean,
): ToolStatus {
	if (outcome !== undefined) return outcome.isError ? "error" : "done";
	if (slot !== undefined) return slot.status === "done" ? "done" : slot.status;
	return settled ? "done" : "pending";
}

/* ---------- pieces ---------- */

export type TracePiece =
	| { kind: "thinking"; id: string; text: string }
	| { kind: "toolCall"; id: string; block: ToolCallPart; status: ToolStatus; slot?: ToolSlotLike; nested: NestedToolSlotLike[] }
	| { kind: "toolResult"; id: string; message: ToolResultMessageLike; status: ToolStatus; duration?: string }
	| { kind: "toolLive"; id: string; tool: ToolSlotLike; status: ToolStatus; nested: NestedToolSlotLike[] };

/**
 * A `generateSandboxedUi` call: produced content, not a trace piece, so the working trace can collapse
 * without taking the widget with it.
 */
export interface WidgetPiece {
	kind: "widget";
	id: string;
	callId: string;
	/** The call's arguments as they stream; `undefined` before the first chunk arrives. */
	args: JsonObject | undefined;
	/** `true` while the model is still streaming the call. */
	streaming: boolean;
}

export type Piece = TracePiece | { kind: "text"; id: string; text: string } | WidgetPiece;

export interface TurnPieceOptions {
	/** `pi.live.nestedTools`: sub-calls a running tool made, attached to their parent's row. */
	readonly nested?: readonly NestedToolSlotLike[];
	/** Debug mode keeps the tool row of a widget call, with its arguments, above the card. */
	readonly widgetRows?: boolean;
}

/**
 * Flatten a turn (and the streaming message, when a turn runs) into pieces. A message carrying text and tool
 * calls yields both: the text ends one bubble, the calls open the next.
 */
export function turnPieces(
	turn: Turn | undefined,
	streaming: MessageLike | undefined,
	tools: readonly ToolSlotLike[],
	options?: TurnPieceOptions,
): Piece[] {
	const outcomes = toolOutcomes(turn?.entries ?? []);
	const slots = new Map(tools.map((slot) => [slot.callId, slot]));
	const nestedByParent = new Map<string, NestedToolSlotLike[]>();
	for (const child of options?.nested ?? []) {
		nestedByParent.set(child.parentCallId, [...(nestedByParent.get(child.parentCallId) ?? []), child]);
	}
	const covered = new Set<string>();
	const pieces: Piece[] = [];

	const addMessage = (prefix: string, message: MessageLike, settled: boolean): void => {
		if (message.role === "toolResult") {
			const result = message as ToolResultMessageLike;
			const duration = result.durationMs === undefined ? undefined : stepDuration(result.durationMs);
			pieces.push({
				kind: "toolResult",
				id: prefix,
				message: result,
				status: result.isError === true ? "error" : "done",
				...(duration === undefined ? {} : { duration }),
			});
			return;
		}
		blocksOf(message).forEach((block, index) => {
			if (isThinkingBlock(block)) {
				if (block.thinking.trim() === "") return;
				pieces.push({ kind: "thinking", id: `${prefix}:${index}`, text: block.thinking });
				return;
			}
			if (isTextBlock(block)) {
				if (block.text.trim() === "") return;
				pieces.push({ kind: "text", id: `${prefix}:${index}`, text: block.text });
				return;
			}
			if (!isToolCall(block)) return;
			covered.add(block.id);
			const call = block;
			const outcome = outcomes.get(call.id);
			const slot = slots.get(call.id);
			const status = toolStatus(outcome, slot, settled);
			const nested = nestedByParent.get(call.id) ?? [];
			const widget = call.name === WIDGET_TOOL && outcome?.isError !== true;
			if (widget) {
				if (options?.widgetRows === true) {
					pieces.push({ kind: "toolCall", id: call.id, block: call, status, ...(slot === undefined ? {} : { slot }), nested });
				}
				pieces.push({
					kind: "widget",
					id: call.id,
					callId: call.id,
					args: call.arguments,
					streaming: !settled,
				});
				return;
			}
			pieces.push({
				kind: "toolCall",
				id: call.id,
				block: call,
				status,
				...(slot === undefined ? {} : { slot }),
				nested,
			});
		});
	};

	if (turn !== undefined) {
		for (const entry of turn.entries) addMessage(String(entry.id), entryMessage(entry) ?? { role: "unknown" }, true);
	}
	if (streaming !== undefined) addMessage("streaming", streaming, false);
	// A running tool whose call is already on screen is rendered there; the rest (a call that a compaction
	// removed) still needs a row while it works.
	for (const tool of tools) {
		if (covered.has(tool.callId)) continue;
		pieces.push({
			kind: "toolLive",
			id: tool.callId,
			tool,
			status: toolStatus(outcomes.get(tool.callId), tool, false),
			nested: nestedByParent.get(tool.callId) ?? [],
		});
	}
	return pieces;
}

/* ---------- bubbles ---------- */

/** The work of one phase and what it produced, if anything. */
export interface Bubble {
	key: string;
	trace: TracePiece[];
	widgets: WidgetPiece[];
	text: string;
}

/**
 * Group pieces into bubbles: a trace piece after produced content opens a new bubble; produced content (text
 * or a widget) always lands in the current one. So a bubble holds [trace] → [what the trace produced], and only
 * the last bubble of a running turn can still be trace-only. Render order inside the bubble comes from
 * `bubbleContent`, not from this grouping.
 *
 * A widget is the exception three times over. Its call's own result is that card's completion rather than new work, so
 * it stays in the card's bubble instead of opening a new one — otherwise the paragraph the model writes about the
 * widget (its tool result and the reasoning that follows sit between the call and that paragraph in the stream) would
 * land *below* the card. Reasoning after a card stays with it for the same reason. And a widget opens a bubble of its
 * own when the current one already holds cards, so two cards never stack under a single shared caption.
 */
export function groupBubbles(pieces: readonly Piece[]): Bubble[] {
	const bubbles: Bubble[] = [];
	let current: Bubble | undefined;
	const start = (piece: Piece): Bubble => {
		const bubble: Bubble = { key: piece.id, trace: [], widgets: [], text: "" };
		bubbles.push(bubble);
		return bubble;
	};
	for (const piece of pieces) {
		if (piece.kind === "text") {
			current ??= start(piece);
			current.text = current.text === "" ? piece.text : `${current.text}\n\n${piece.text}`;
			continue;
		}
		if (piece.kind === "widget") {
			if (current === undefined || current.widgets.length > 0) current = start(piece);
			current.widgets.push(piece);
			continue;
		}
		if (
			piece.kind === "toolResult" &&
			current !== undefined &&
			current.widgets.some((widget) => widget.callId === piece.message.toolCallId)
		) {
			current.trace.push(piece);
			continue;
		}
		// Reasoning that follows a card is the model thinking about what it just built; the paragraph it leads to
		// is the card's caption. Thinking is invisible outside debug mode, so splitting on it would strand that
		// caption — and the card — in bubbles of their own.
		if (piece.kind === "thinking" && current !== undefined && current.widgets.length > 0) {
			current.trace.push(piece);
			continue;
		}
		if (current === undefined || current.text !== "" || current.widgets.length > 0) current = start(piece);
		current.trace.push(piece);
	}
	return bubbles;
}

export interface ToolPairing {
	/** The result of a call, by call id. */
	byCall: Map<string, ToolResultMessageLike>;
	/** Results whose call is not part of this trace (a compaction dropped it): they need their own row. */
	orphans: ToolResultMessageLike[];
}

/** Pair a trace's results with the calls they answered. */
export function pairToolResults(pieces: readonly TracePiece[]): ToolPairing {
	const calls = new Set(pieces.filter((piece) => piece.kind === "toolCall").map((piece) => piece.block.id));
	const byCall = new Map<string, ToolResultMessageLike>();
	const orphans: ToolResultMessageLike[] = [];
	for (const piece of pieces) {
		if (piece.kind !== "toolResult") continue;
		const callId = piece.message.toolCallId;
		byCall.set(callId, piece.message);
		if (!calls.has(callId)) orphans.push(piece.message);
	}
	return { byCall, orphans };
}

/** True when a bubble has something to show besides its trace. */
export function bubbleHasContent(bubble: Bubble): boolean {
	return bubble.text.trim() !== "" || bubble.widgets.length > 0;
}

/** Produced content in the order the view renders it: the text, then the widgets it introduces. */
export type BubbleContent =
	| { kind: "text"; key: string; text: string }
	| { kind: "widget"; key: string; piece: WidgetPiece };

/**
 * What a bubble shows, in render order: the text first, widgets last.
 *
 * A model writes its lead-in text and then calls the tool, but call and text land in the same bubble and the
 * two are not in stream order by the time a turn is read back — a message may carry text, a widget call, and
 * more text, and the follow-up answer arrives in a message of its own. The text is what the model wrote *about*
 * the widget, so the widget closes the bubble: a card never appears above the paragraph that introduces it.
 */
export function bubbleContent(bubble: Bubble): BubbleContent[] {
	const content: BubbleContent[] = [];
	if (bubble.text.trim() !== "") content.push({ kind: "text", key: `${bubble.key}:text`, text: bubble.text });
	for (const piece of bubble.widgets) content.push({ kind: "widget", key: piece.id, piece });
	return content;
}

/* ---------- readers for the view ---------- */

/** The text a note entry carries: a compaction summary, a reset handoff, or nothing. */
export function noteText(entry: EntryLike): string {
	return textOf(entryMessage(entry)).trim();
}

/** The one-line summary of an unknown tool call, for a row or a debug line. */
export function toolSummary(name: string, args: unknown): string {
	return summarizeArgs(args) || name;
}
