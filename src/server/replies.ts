/**
 * Sends: the one operation through which a turn's words reach a reader, and the durable record it commits.
 *
 * A turn always has an **origin** — the connector that carried the person's words, or the transcript itself when
 * nobody carried them — and `send` addresses it. The model never names a vendor's tool, and an event's instruction never
 * names one either: the routing is mason's, decided from what actually started the turn rather than from prose in a
 * prompt. Nor does it name an address: there is no other destination to name (#200).
 *
 * Three shapes, and they differ in where the words land, not in how they are committed:
 *
 * - a person wrote in a connector: the send is addressed to that connector and the opaque `ref` it minted, and the
 *   outbox delivers it;
 * - mason wrote the words (a routine, a retry): the transcript is the medium, so the send is committed and that is the
 *   delivery;
 * - nothing that carries words started the turn (a schedule, an event from a service with no reader): the send is still
 *   committed — the work is recorded — and the result says nobody was reached. Claiming a delivery nobody received is
 *   the one outcome the whole arrangement exists to avoid.
 *
 * ## Where the origin lives
 *
 * A connector's submission is placed as an `app.connector` entry whose `data` carries the origin, and an event is an
 * `app.hook` entry that carries one when it named it. That is the durable record: a restart, a compaction or a
 * reconnect cannot lose it, and the send reads it from the transcript — the same place the reader does — rather than
 * from anything the model was asked to remember.
 *
 * The newest input entry is the turn's input. A queued follow-up has no entry until the inbox places it, and a steer is
 * placed at the boundary it interrupts, so "newest input" is exactly "the input this turn is answering".
 */

import type { Context } from "@earendil-works/chord";
import type { ConversationId, Cursor, EntryRecord, Tx } from "@earendil-works/pi-durable";
import type { Actor, ContentBlock, Origin } from "mason-protocol";
import { CONNECTOR_ENTRY_KIND, HOOK_ENTRY_KIND, isDeliveryReminder, isReflectionAsk } from "../shared/contract.ts";
import type { Integration } from "./integrations.ts";

/** Where a send goes: one connector, and the address it minted on the append the turn came from. */
export interface SendAddress {
	readonly connector: string;
	/** The opaque address the connector minted on the append a turn came from. */
	readonly ref?: string;
}

/**
 * One committed send, as the `app.reply` entry holds it.
 *
 * `address` absent means the transcript is the medium: a reader of the home sees it, and nothing is delivered anywhere.
 * `origin` is kept even when an address is derived from it, so a later reader can tell which submission a message
 * answers.
 */
export interface ReplyRecord {
	readonly deliveryId: string;
	readonly blocks: readonly ContentBlock[];
	readonly address?: SendAddress;
	readonly origin?: Origin;
}

/** What started the turn whose send is being written. */
export type TurnOrigin =
	| { readonly kind: "local" }
	| { readonly kind: "connector"; readonly origin: Origin }
	| { readonly kind: "hook"; readonly origin?: Origin };

/** The message a model reads out of an entry, if it is an input at all. */
function userText(entry: EntryRecord): string | undefined {
	for (const message of entry.model ?? []) {
		if (message.role !== "user") continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => {
				const block = part as { type?: unknown; text?: unknown };
				return block.type === "text" && typeof block.text === "string" ? block.text : "";
			})
			.join("");
	}
	return undefined;
}

/** An actor, as an entry's `data.origin` holds it, or `undefined` when the shape is not one this build wrote. */
function actorOf(value: unknown): Actor | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const actor = value as Record<string, unknown>;
	if (typeof actor.id !== "string") return undefined;
	return { id: actor.id, ...(typeof actor.name === "string" ? { name: actor.name } : {}) };
}

/** An origin as an entry's `data.origin` holds it, or `undefined` when the shape is not one this build wrote. */
export function originOf(data: unknown): Origin | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const raw = (data as { origin?: unknown }).origin;
	if (typeof raw !== "object" || raw === null) return undefined;
	const origin = raw as Record<string, unknown>;
	const actor = actorOf(origin.actor);
	if (typeof origin.connector !== "string" || typeof origin.ref !== "string") return undefined;
	return {
		connector: origin.connector,
		ref: origin.ref,
		...(typeof origin.messageId === "string" ? { messageId: origin.messageId } : {}),
		...(actor === undefined ? {} : { actor }),
	};
}

/**
 * The turn whose send is being written: the newest input entry that is not a gate's own words.
 *
 * Read from the end because the newest one is the input in hand. `undefined` when the transcript holds no input at all —
 * a compacted or resumed turn — which is read as a local turn, the same fallback the delivery gate takes.
 */
export function turnOriginOf(entries: readonly EntryRecord[]): TurnOrigin {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as EntryRecord;
		if (isInputEntry(entry)) return turnOriginOfEntry(entry);
	}
	return { kind: "local" };
}

/**
 * The entry kinds that are mason's own working notes and never a turn's input, whatever their messages look like.
 *
 * A compaction's summary is a `user`-role message (`pi.compaction`), and so is the prompt a turn was planned with
 * (`pi.system`): reading either as the newest input is what made #199 erase a turn's origin mid-turn, so the kinds are
 * refused here rather than recognised by what their text says.
 */
const NOT_INPUT_KINDS: ReadonlySet<string> = new Set(["pi.compaction", "pi.system"]);

/**
 * Whether an entry is an input at all. A connector entry is always the sender's words: anything a person may type is
 * what the wire carried, including the first words a gate prints, and only mason's own side writes a gate's words. The
 * delivery reminder and the reflection ask are things the model reads mid-turn, not words a person sent, so a turn that
 * began with a person keeps its origin even after a gate wrote the newest entry in the transcript. An entry kind that is
 * a working note is not an input whatever its text says: that is the half of this rule a kind decides (#199).
 *
 * `test/delivery-gate.test.ts` pins both halves: a compaction between the person's entry and the send, and a system
 * entry that carries a user-role message.
 */
export function isInputEntry(entry: EntryRecord): boolean {
	if (NOT_INPUT_KINDS.has(entry.kind)) return false;
	const text = userText(entry);
	if (entry.kind === CONNECTOR_ENTRY_KIND) return text !== undefined;
	return text !== undefined && !isDeliveryReminder(text) && !isReflectionAsk(text);
}

/**
 * What one input entry makes the turn: a connector's words carry an origin, an event may, and everything else is the
 * local turn's.
 *
 * A connector entry without a usable origin cannot be answered — the words are still a person's, but nothing says where
 * they came from — so the send falls back to the transcript rather than inventing a destination.
 */
export function turnOriginOfEntry(entry: EntryRecord): TurnOrigin {
	const origin = originOf(entry.data);
	if (entry.kind === CONNECTOR_ENTRY_KIND) {
		return origin === undefined ? { kind: "local" } : { kind: "connector", origin };
	}
	if (entry.kind === HOOK_ENTRY_KIND) return origin === undefined ? { kind: "hook" } : { kind: "hook", origin };
	return { kind: "local" };
}

/** The entry a send is written against: the turn's input, for a caller that needs the whole record rather than its origin. */
export function latestInputOf(entries: readonly EntryRecord[]): EntryRecord | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as EntryRecord;
		if (isInputEntry(entry)) return entry;
	}
	return undefined;
}

/** One committed send read back out of its entry, or `undefined` for a shape this build did not write. */
export function replyRecordOf(entry: EntryRecord): ReplyRecord | undefined {
	if (entry.kind !== "app.reply") return undefined;
	if (typeof entry.data !== "object" || entry.data === null) return undefined;
	const data = entry.data as Record<string, unknown>;
	if (typeof data.deliveryId !== "string" || data.deliveryId === "") return undefined;
	const blocks = Array.isArray(data.blocks) ? data.blocks.filter(isContentBlock) : [];
	const raw = data.target as Record<string, unknown> | undefined;
	const address =
		typeof raw === "object" && raw !== null && typeof raw.connector === "string"
			? { connector: raw.connector, ...(typeof raw.ref === "string" ? { ref: raw.ref } : {}) }
			: undefined;
	return {
		deliveryId: data.deliveryId,
		blocks,
		...(address === undefined ? {} : { address }),
		...(originOf(data) === undefined ? {} : { origin: originOf(data) as Origin }),
	};
}

function isContentBlock(value: unknown): value is ContentBlock {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "text" || type === "markdown" || type === "file" || type === "notice";
}

/** The text of a send: text and markdown blocks joined, which is what a reader's bubble shows. */
export function textOfBlocks(blocks: readonly ContentBlock[]): string {
	return blocks
		.flatMap((block) =>
			block.type === "text" || block.type === "markdown" || block.type === "notice" ? [block.text] : [],
		)
		.join("");
}

/**
 * Whether an address is one this boot can reach: the connector is enabled, and it is still the connector that carried
 * the words.
 *
 * The check is the operator's configuration, read from the boot's snapshot — the same answer the session gives, so a
 * send can never address a connector the operator switched off mid-turn.
 */
export function reachableAddress(
	integrations: Record<string, Integration>,
	address: SendAddress,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
	const integration = integrations[address.connector];
	if (integration === undefined || !integration.enabled || integration.connector === undefined) {
		return { ok: false, reason: `"${address.connector}" is not an enabled connector` };
	}
	return { ok: true };
}

/** The address a turn's origin implies, when the origin is one a send can go back to. */
export function addressOfOrigin(origin: Origin): SendAddress {
	return { connector: origin.connector, ref: origin.ref };
}

/**
 * The origin a turn that resumes an older one inherits: where the turn it resumes was answering, or nowhere.
 *
 * A retry is an event, so the turn it starts has no input of its own to route by — the person waiting on the run that
 * died is behind an older entry. Handing that entry's origin to the fire is what makes the resumed turn's send reach
 * them; without it the answer is committed to a transcript nobody in the chat can see, which is what #83 caught.
 */
export function resumedOrigin(entries: readonly EntryRecord[]): Origin | undefined {
	const origin = turnOriginOf(entries);
	return origin.kind === "local" ? undefined : origin.origin;
}

/** How far back a turn's input can be — a round of tool calls is one entry each, and a page always ends. */
const TURN_INPUT_PAGE = 128;
const TURN_INPUT_MAX_PAGES = 16;

/** The little of a tool's execution API this read needs: its conversation, and a committed scan of it. */
export interface TurnOriginReader {
	readonly conversationId: ConversationId;
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
}

/**
 * The turn this call belongs to, read from the transcript.
 *
 * A tool cannot see the request that made its call, so this reads the newest input entry — the same entry the delivery
 * gate reads — rather than trusting the model to remember where the turn came from, so a send and the gate cannot
 * disagree about where a turn came from.
 */
export async function readTurnOrigin(api: TurnOriginReader, context: Context): Promise<TurnOrigin> {
	return api.commit((tx) => turnOriginIn(tx, api.conversationId), context);
}

/**
 * The same read, against a transaction the caller already has.
 *
 * It exists because the two callers commit differently: a tool's `commit` answers with the callback's value, while a
 * task's `commit` adopts that value as its own state. The scan itself is one function, so neither caller can drift from
 * the other's idea of the newest input.
 */
export async function turnOriginIn(tx: Tx, conversationId: ConversationId): Promise<TurnOrigin> {
	const entry = await turnInputIn(tx, conversationId);
	return entry === undefined ? { kind: "local" } : turnOriginOfEntry(entry);
}

/**
 * The newest input entry itself, for a caller that needs more than where the turn came from.
 *
 * The input entry is what a retry or a resumed event inherits its destination from: it is where mason wrote the origin a
 * connector sent, and a turn's own words are the only place that origin exists.
 */
export async function turnInputIn(tx: Tx, conversationId: ConversationId): Promise<EntryRecord | undefined> {
	let cursor: Cursor | undefined;
	for (let page = 0; page < TURN_INPUT_MAX_PAGES; page += 1) {
		const scanned = await tx.scanEntries({ conversationId, order: "descending" }, TURN_INPUT_PAGE, cursor);
		// Descending, so the first input in the page is the newest one in the transcript.
		for (const entry of scanned.items) {
			if (isInputEntry(entry)) return entry;
		}
		if (scanned.next === undefined) break;
		cursor = scanned.next;
	}
	return undefined;
}
