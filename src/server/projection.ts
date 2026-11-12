/**
 * What the reader is allowed to see, derived from the durable conversation.
 *
 * This module is the wire boundary, and the only place that decides what crosses it. Everything the model does —
 * reasoning, tool calls, tool arguments, tool output, usage, the raw entries — stays here, on the server. What leaves
 * is the conversation as a person reads it: their own words, the messages the agent chose to send (`send`),
 * and a coarse notice when a run failed.
 *
 * The rule is a whitelist, not a filter: a transcript item exists only because something here names it. A new entry
 * kind or a new tool cannot leak by default — it is invisible until this file says otherwise. The raw view stays
 * available server-side (the run supervisor reads it), and a trace endpoint can expose it later, deliberately.
 */
import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { QueuedItem, TranscriptItem } from "../shared/contract.ts";
import {
	CONNECTOR_ENTRY_KIND,
	DELIVERY_ENTRY_KIND,
	HOOK_ENTRY_KIND,
	isDeliveryReminder,
	isReflectionAsk,
	NOTICE_ENTRY_KIND,
	REPLY_ENTRY_KIND,
	SEND_TOOL,
	splitAuthor,
} from "../shared/contract.ts";
import { replyRecordOf, textOfBlocks } from "./replies.ts";

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

function callsOf(message: unknown): CallBlock[] {
	return contentBlocks(message).filter((part): part is CallBlock => (part as CallBlock).type === "toolCall");
}

/** What became of one delivery, as the entry records it. */
interface DeliveryRecord {
	readonly deliveryId: string;
	readonly status: "delivered" | "duplicate" | "uncertain" | "rejected";
	readonly detail?: string;
}

function deliveryRecordOf(entry: EntryRecord): DeliveryRecord | undefined {
	if (entry.kind !== DELIVERY_ENTRY_KIND) return undefined;
	if (typeof entry.data !== "object" || entry.data === null) return undefined;
	const data = entry.data as Record<string, unknown>;
	if (typeof data.deliveryId !== "string") return undefined;
	const status = data.status;
	if (status !== "delivered" && status !== "duplicate" && status !== "uncertain" && status !== "rejected") {
		return undefined;
	}
	return {
		deliveryId: data.deliveryId,
		status,
		...(typeof data.detail === "string" ? { detail: data.detail } : {}),
	};
}

/**
 * The reader's transcript: every entry a person is meant to see, in order, and nothing else.
 *
 * A person's words are an input entry — `app.connector` through a connector, `pi.user` when mason wrote them. A send is
 * the `app.reply` entry `send` commits, which is the delivery itself: the assistant message that carried the call
 * contributes nothing, so a message appears once whether it was streamed or committed. An event is a row of its own,
 * because a wake nobody can see is a wake nobody can explain. Tool results are read for failure alone, never forwarded.
 *
 * The round in flight contributes the same shape, streaming: a reply appears as the model writes it, exactly as it will
 * stand once committed. A streaming reply whose entry has already landed is skipped — the entry is the truth, and two
 * copies of one message is the duplicate the outbox exists to prevent.
 *
 * Two kinds reach here and stop: `app.command` (a chat asked for `/stop`, and the trace of that request belongs to the
 * log, not the reader) and `pi.compaction`. Neither carries a word for the reader, and the tests pin that they do not
 * cross the wire.
 */
export function projectTranscript(view: ConversationView | undefined): TranscriptItem[] {
	const { fold, tail } = foldTranscript(view);
	return [...fold.items, ...tail];
}

/**
 * The id prefix of the notice a run that died leaves, and the one spelling of it: the read model reads it back to tell
 * an ended run that failed from one that finished.
 */
export const FAILED_NOTICE_PREFIX = "failed:";

/**
 * The committed rows of a transcript, folded once so a later revision can reuse them.
 *
 * Entries are append-only, so the rows a prefix of them produced never change — with one exception a later entry can
 * move: a delivery acknowledgement that says the message may not have arrived adds a notice behind the row it settles,
 * and `notices` is what tells a fold that the rows it holds are no longer the whole story. Everything else an entry
 * contributes depends on the entries before it, which is why a fold can be resumed at the entry it stopped at.
 */
export interface TranscriptFold {
	/** The rows, one object per row: a later revision reuses these objects, which is what makes its diff a tail diff. */
	readonly items: readonly TranscriptItem[];
	/** Whether the turn being read has already been told anything, after the last entry folded. */
	readonly spoke: boolean;
	/** The entry ids folded, in order: a view that rewrote one of them is not a view that appended to them. */
	readonly ids: readonly string[];
	/** The delivery ids that are a notice of their own, sorted: a new one changes a row already folded. */
	readonly notices: readonly string[];
}

/**
 * Fold the view's committed entries onto `before`, and project the round in flight beside them.
 *
 * `before` is the previous revision's fold, and folding onto it is what keeps a token from rebuilding the transcript:
 * when the view only appended, the rows up to the last entry are reused object for object and only what follows is
 * derived. A view that rewrote an entry, or a delivery notice that landed behind one, starts the fold again — the rows
 * are then equal but not shared, and the diff that follows is still a tail diff, because equality is what a diff reads.
 */
export function foldTranscript(
	view: ConversationView | undefined,
	before?: TranscriptFold,
): { readonly fold: TranscriptFold; readonly tail: TranscriptItem[] } {
	const entries = (view?.entries ?? []) as readonly EntryRecord[];
	const { outcomes, replies, deliveries } = scanEntries(entries);
	const notices = noticeIdsOf(deliveries);
	const resumed = before !== undefined && before.ids.length <= entries.length && sameIds(before.ids, entries);
	const reuse = resumed && sameStrings(before.notices, notices);
	const items: TranscriptItem[] = reuse ? [...before.items] : [];
	// A turn nobody has read the start of has spoken until an entry says otherwise: the same default the whole view gets.
	let spoke = reuse ? before.spoke : true;
	for (let index = reuse ? before.ids.length : 0; index < entries.length; index += 1) {
		spoke = foldEntry(entries[index] as EntryRecord, deliveries, items, spoke);
	}
	const ids = resumed ? [...before.ids, ...entries.slice(before.ids.length).map(idOf)] : entries.map(idOf);
	return { fold: { items, spoke, ids, notices }, tail: streamingItems(view, outcomes, replies) };
}

/** The three maps every row is read against, built in one pass over the entries. */
function scanEntries(entries: readonly EntryRecord[]): {
	readonly outcomes: Map<string, boolean>;
	readonly replies: Set<string>;
	readonly deliveries: Map<string, DeliveryRecord>;
} {
	const outcomes = new Map<string, boolean>();
	const replies = new Set<string>();
	const deliveries = new Map<string, DeliveryRecord>();
	for (const entry of entries) {
		if (entry.kind === "pi.tool-result") {
			const message = messageOf(entry) as { toolCallId?: unknown; isError?: unknown } | undefined;
			if (typeof message?.toolCallId === "string") outcomes.set(message.toolCallId, message.isError === true);
			continue;
		}
		if (entry.kind === REPLY_ENTRY_KIND) {
			const record = replyRecordOf(entry);
			if (record !== undefined) replies.add(record.deliveryId);
			continue;
		}
		const delivery = deliveryRecordOf(entry);
		if (delivery !== undefined) deliveries.set(delivery.deliveryId, delivery);
	}
	return { outcomes, replies, deliveries };
}

/** The entry's id, as a row and the fold that holds it spell it. */
function idOf(entry: EntryRecord): string {
	return String(entry.id);
}

/** Whether a fold's prefix still matches the view it is folded onto: the same entries, in the same order, from the top. */
function sameIds(ids: readonly string[], entries: readonly EntryRecord[]): boolean {
	for (let index = 0; index < ids.length; index += 1) {
		const entry = entries[index];
		if (entry === undefined || idOf(entry) !== ids[index]) return false;
	}
	return true;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The acknowledgements that are a row of their own, sorted so two folds of one view compare equal. */
function noticeIdsOf(deliveries: Map<string, DeliveryRecord>): string[] {
	const ids: string[] = [];
	for (const [id, record] of deliveries) {
		if (record.status === "uncertain" || record.status === "rejected") ids.push(id);
	}
	return ids.sort();
}

/**
 * One entry, folded into the reader's rows, and whether the turn has now spoken.
 *
 * The whole whitelist lives here: `foldTranscript` decides *where* to start, this decides *what one entry is allowed to
 * become*. An entry kind this does not name contributes nothing, which is the property the tests in
 * `test/projection.test.ts` exist to keep.
 */
function foldEntry(
	entry: EntryRecord,
	deliveries: Map<string, DeliveryRecord>,
	items: TranscriptItem[],
	spoke: boolean,
): boolean {
	if (entry.kind === HOOK_ENTRY_KIND) {
		// A fire is a turn that owed the person words, whether it names a kind or is a routine's timer: an event is the
		// reader's business and says so as a row of its own, and a routine's message is the row — but a fire that sent
		// nothing is a silence, and the schedule is the schedule's business either way.
		const kind = (entry.data as { kind?: unknown } | undefined)?.kind;
		if (typeof kind === "string" && kind !== "") {
			items.push({ kind: "event", id: String(entry.id), name: kind });
		}
		return false;
	}
	if (entry.kind === NOTICE_ENTRY_KIND) {
		// The medium talking about itself: a channel that was muted, a delivery that the network refused. It is not a
		// turn and it never woke one, so it is a row and not a message from anybody.
		const text = (entry.data as { text?: unknown } | undefined)?.text;
		if (typeof text === "string" && !isBlank(text)) {
			items.push({ kind: "notice", id: `medium:${entry.id}`, text });
		}
		return spoke;
	}
	if (entry.kind === "pi.user" || entry.kind === CONNECTOR_ENTRY_KIND) {
		const spoken = textOfMessage(messageOf(entry)).trim();
		// A gate's own words are user entries the model reads, not ones the reader sent: the delivery reminder, in
		// either shape a local turn and a fired turn get, and the reflection ask at the end of a long turn.
		const gate = entry.kind !== CONNECTOR_ENTRY_KIND && (isDeliveryReminder(spoken) || isReflectionAsk(spoken));
		if (spoken !== "" && !gate) {
			const { text, author } = splitAuthor(spoken);
			items.push({ kind: "user", id: String(entry.id), text, ...(author === undefined ? {} : { author }) });
			return false;
		}
		return gate ? spoke : false;
	}
	if (entry.kind === REPLY_ENTRY_KIND) {
		const record = replyRecordOf(entry);
		if (record === undefined) return spoke;
		const text = textOfBlocks(record.blocks);
		if (isBlank(text)) return spoke;
		items.push({ kind: "delivered", id: record.deliveryId, text });
		const delivery = deliveries.get(record.deliveryId);
		// A delivery that may not have arrived is the reader's business: the message is on screen, and whether a
		// person received it is not something the transcript may leave implied.
		if (delivery !== undefined && (delivery.status === "uncertain" || delivery.status === "rejected")) {
			items.push({
				kind: "notice",
				id: `delivery:${record.deliveryId}`,
				text:
					delivery.status === "uncertain"
						? "This message may not have reached the chat: the connector could not tell whether it was sent."
						: "This message did not reach the chat: the connector refused it.",
			});
		}
		return true;
	}
	if (entry.kind === "pi.assistant") {
		// A run that died is the reader's business; the reason it died is not. One coarse line, once per run.
		const failed = (messageOf(entry) as { stopReason?: unknown } | undefined)?.stopReason === "error";
		if (failed && items[items.length - 1]?.kind !== "notice") {
			items.push({
				kind: "notice",
				id: `${FAILED_NOTICE_PREFIX}${entry.id}`,
				text: "Something went wrong, and the turn did not finish.",
			});
			return true;
		}
		// Decided after the calls, because an answer that carries its own delivery is not silence. A tool round is
		// not speech either: only the entries and calls this file forwards above count as having said something.
		if (!failed && !spoke && (messageOf(entry) as { stopReason?: unknown } | undefined)?.stopReason === "stop") {
			// The gate gave the turn a second chance and it stayed silent anyway. Saying so is still better than the
			// person wondering whether the agent is working or gone.
			items.push({
				kind: "notice",
				id: `silent:${entry.id}`,
				text: "The agent finished without sending you a message.",
			});
			return true;
		}
	}
	return spoke;
}

/**
 * The calls of the in-flight round, projected the same way, marked streaming.
 *
 * A reply streams under the id its entry will carry — `reply:<callId>` — so the bubble a reader is watching becomes the
 * message without a second row appearing.
 */
function streamingItems(
	view: ConversationView | undefined,
	outcomes: Map<string, boolean>,
	replies: Set<string>,
): TranscriptItem[] {
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
		if (call.name === SEND_TOOL) {
			const text = typeof args.text === "string" ? args.text : "";
			if (isBlank(text)) continue;
			const deliveryId = `reply:${call.id}`;
			// The entry has landed, so the committed row is the message; a streaming copy beside it would be the same
			// words twice.
			if (replies.has(deliveryId)) continue;
			items.push({ kind: "delivered", id: deliveryId, text, streaming: true });
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
		const item = raw as {
			id?: unknown;
			mode?: unknown;
			content?: unknown;
			entry?: { kind?: string; data?: unknown };
		};
		if (typeof item.id !== "number") continue;
		const { text, author } = splitAuthor(queuedText(item));
		queued.push({
			id: item.id,
			mode: typeof item.mode === "string" ? item.mode : "followUp",
			text,
			...(author === undefined ? {} : { author }),
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
