/**
 * What the reader is allowed to see, derived from the durable conversation.
 *
 * This module is the wire boundary, and the only place that decides what crosses it. Everything the model does —
 * reasoning, tool calls, tool arguments, tool output, usage, the raw entries — stays here, on the server. What leaves
 * is the conversation as a person reads it: their own words, the messages the agent chose to send (`send_to_user`),
 * the widgets it built for them, the trigger that woke it, and a coarse notice when a run failed.
 *
 * The rule is a whitelist, not a filter: a transcript item exists only because something here names it. A new entry
 * kind or a new tool cannot leak by default — it is invisible until this file says otherwise. The raw view stays
 * available server-side (the run supervisor reads it), and a trace endpoint can expose it later, deliberately.
 */
import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { QueuedItem, TranscriptItem } from "../shared/contract.ts";
import { HOOK_ENTRY_KIND, MESSAGE_TOOL } from "../shared/contract.ts";
import { contentFromToolCall, type OpenGenUIContent } from "../shared/genui-content.ts";
import { hookData } from "./status.ts";

/** The tool whose calls are user-facing artifacts rather than working notes. */
export const WIDGET_TOOL = "generateSandboxedUi";

/**
 * Whether a message says nothing: empty, whitespace only, or invisible characters alone.
 *
 * `minLength: 1` admits a lone space and a lone zero-width space, which the renderer would pad into an empty bubble.
 */
function isBlank(text: string): boolean {
	return text.replace(/[\s\u200b-\u200d\ufeff]/g, "") === "";
}

/** The one message an entry carries. */
function messageOf(entry: EntryRecord): unknown {
	const model = (entry as { model?: unknown }).model;
	return Array.isArray(model) ? model[0] : undefined;
}

function contentBlocks(message: unknown): readonly unknown[] {
	const content = (message as { content?: unknown } | undefined)?.content;
	return Array.isArray(content) ? content : [];
}

/** The text of a message: a plain string, or its text blocks joined. Reasoning and calls are not text. */
function textOfMessage(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	return contentBlocks(message)
		.map((part) => {
			const block = part as { type?: string; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.join("");
}

interface CallBlock {
	type?: string;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
}

/** The `send_to_user` and widget calls of one assistant message, in the order the model made them. */
function callsOf(message: unknown): CallBlock[] {
	return contentBlocks(message).filter((part): part is CallBlock => (part as CallBlock).type === "toolCall");
}

/** Whether the call's result says it failed — an error result, or one interrupted by a restart. */
function outcomeFailed(outcomes: Map<string, boolean>, callId: string): boolean {
	return outcomes.get(callId) === true;
}

/**
 * The reader's transcript: every entry the person is meant to see, in order, and nothing else.
 *
 * `pi.assistant` contributes only the calls this file names — its prose, its reasoning and every other call are
 * working notes. A `send_to_user` call is the message; a widget call is the artifact. Tool results are read for
 * failure alone, never forwarded.
 *
 * The round in flight contributes the same two shapes, streaming: a message appears as the model writes it, a widget
 * as its markup arrives, exactly as they will stand once committed. A half-written message is the one thing the reader
 * is meant to watch.
 */
export function projectTranscript(view: ConversationView | undefined): TranscriptItem[] {
	const entries = (view?.entries ?? []) as readonly EntryRecord[];
	const outcomes = new Map<string, boolean>();
	for (const entry of entries) {
		if (entry.kind !== "pi.tool-result") continue;
		const message = messageOf(entry) as { toolCallId?: unknown; isError?: unknown } | undefined;
		if (typeof message?.toolCallId !== "string") continue;
		outcomes.set(message.toolCallId, message.isError === true);
	}

	const items: TranscriptItem[] = [];
	for (const entry of entries) {
		if (entry.kind === "pi.user") {
			const text = textOfMessage(messageOf(entry)).trim();
			if (text !== "") items.push({ kind: "user", id: String(entry.id), text });
			continue;
		}
		if (entry.kind === HOOK_ENTRY_KIND) {
			const data = hookData(entry);
			items.push({
				kind: "hook",
				id: String(entry.id),
				hookName: data.hookName,
				firedAt: data.firedAt,
				...(data.payload === null ? {} : { payload: data.payload }),
			});
			continue;
		}
		if (entry.kind === "pi.assistant") {
			// A run that died is the reader's business; the reason it died is not. One coarse line, once per run.
			const failed = (messageOf(entry) as { stopReason?: unknown } | undefined)?.stopReason === "error";
			if (failed && items[items.length - 1]?.kind !== "notice") {
				items.push({ kind: "notice", id: `failed:${entry.id}`, text: "Something went wrong, and the turn did not finish." });
			}
			for (const call of callsOf(messageOf(entry))) {
				if (typeof call.id !== "string") continue;
				const args = (typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {}) as Record<
					string,
					unknown
				>;
				if (call.name === MESSAGE_TOOL) {
					const text = typeof args.message === "string" ? args.message : "";
					// A blank message is not a message: the renderer would pad it into an empty bubble.
					if (isBlank(text)) continue;
					const failed = outcomeFailed(outcomes, call.id);
					items.push({
						kind: "delivered",
						id: call.id,
						text,
						...(failed ? { failed: true } : {}),
					});
					continue;
				}
				if (call.name === WIDGET_TOOL && !outcomeFailed(outcomes, call.id)) {
					items.push({
						kind: "widget",
						id: call.id,
						streaming: false,
						content: contentFromToolCall(args as never, true) satisfies OpenGenUIContent,
					});
				}
			}
			continue;
		}
	}
	items.push(...streamingItems(view, outcomes));
	return items;
}

/** The calls of the in-flight round, projected the same way, marked streaming. */
function streamingItems(view: ConversationView | undefined, outcomes: Map<string, boolean>): TranscriptItem[] {
	const live = view?.docs["pi.live"] as LiveState | undefined;
	const inFlight = live?.generation?.message;
	if (inFlight === undefined) return [];
	const items: TranscriptItem[] = [];
	for (const call of callsOf(inFlight)) {
		if (typeof call.id !== "string") continue;
		// A call whose result already committed is in the transcript proper; only a call still awaiting one streams.
		if (outcomes.has(call.id)) continue;
		const args = (typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {}) as Record<
			string,
			unknown
		>;
		if (call.name === MESSAGE_TOOL) {
			const text = typeof args.message === "string" ? args.message : "";
			if (isBlank(text)) continue;
			items.push({ kind: "delivered", id: call.id, text, streaming: true });
			continue;
		}
		if (call.name === WIDGET_TOOL) {
			items.push({
				kind: "widget",
				id: call.id,
				streaming: true,
				content: contentFromToolCall(args as never, false) satisfies OpenGenUIContent,
			});
		}
	}
	return items;
}

/**
 * The queue behind the running turn, labelled for the reader: their own words, or the hook an input becomes.
 *
 * A submission that is no longer withdrawable is one the inbox has already turned into an entry; the reader is told
 * by the label and the button goes.
 */
export function projectQueued(view: ConversationView | undefined): QueuedItem[] {
	const inbox = view?.docs["pi.inbox"] as { items?: readonly unknown[] } | undefined;
	const items = inbox?.items ?? [];
	const queued: QueuedItem[] = [];
	for (const raw of items) {
		const item = raw as { id?: unknown; mode?: unknown; content?: unknown; entry?: { kind?: string; data?: unknown } };
		if (typeof item.id !== "number") continue;
		const text = queuedText(item);
		queued.push({
			id: item.id,
			mode: typeof item.mode === "string" ? item.mode : "followUp",
			text,
			withdrawable: item.entry === undefined,
		});
	}
	return queued;
}

function queuedText(item: { content?: unknown; entry?: { kind?: string; data?: unknown } }): string {
	const content = item.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return textOfMessage({ content });
	if (item.entry?.kind === HOOK_ENTRY_KIND) {
		const data = item.entry.data as { hookName?: unknown } | undefined;
		return `hook: ${typeof data?.hookName === "string" ? data.hookName : "event"}`;
	}
	return "queued";
}

/** The names of the tools the running round has not finished. Names only — never arguments, never output. */
export function runningToolNames(view: ConversationView | undefined): string[] {
	const live = view?.docs["pi.live"] as LiveState | undefined;
	const tools = live?.tools ?? [];
	const names: string[] = [];
	for (const tool of tools) {
		if (tool.status === "done") continue;
		if (!names.includes(tool.name)) names.push(tool.name);
	}
	return names;
}
