/**
 * `reply`: the one channel through which a turn's words reach a reader.
 *
 * Routing is mason's, not the model's. A turn knows its origin from the transcript — the `app.connector` or `app.hook`
 * entry that started it — and the tool addresses the reply there. There is no vendor tool to name and no prompt that
 * names one: a chat, the transcript and a schedule are the same call, and only the destination differs.
 *
 * Three outcomes, and the result says which:
 *
 * - **delivered** — the transcript is the reader; the entry the call commits *is* the delivery.
 * - **queued** — a connector is the reader; the entry is the durable outbox, and the socket sends it, resends it after a
 *   reconnect, and records the acknowledgement. Saying "delivered" here would be a promise this process cannot keep.
 * - **nobody reached** — a hooked turn with no origin that named no target. The work is recorded and the model is told
 *   that no person has it, which is the truth; a message nobody received is the worst outcome the arrangement exists to
 *   avoid.
 *
 * `replay` is explicit, though `"unsafe"` is pi's default: re-running an interrupted call after a restart would commit
 * the same message twice. An interrupted call is never re-executed — it settles as an `interrupted` error result, which
 * the client shows as a bubble that may not have reached the reader.
 *
 * A **nested** call — `tools.reply()` inside a code-mode script — is refused: its result goes back to the script instead
 * of into the transcript, so nothing reaches the reader while the script is told it did. The entry is the delivery, and
 * a script cannot write one that a reader sees; the refusal says what to do instead.
 */
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DELIVERY_REMINDER, isDeliveryReminder, REPLY_ENTRY_KIND, REPLY_TOOL } from "../../shared/contract.ts";
import { currentIntegrations } from "../integrations.ts";
import {
	type ReplyRecord,
	type ReplyTarget,
	reachableTarget,
	readTurnOrigin,
	type TurnOrigin,
	targetOfOrigin,
} from "../replies.ts";
import { nestedRefusal } from "./nested.ts";

const ReplyParams = Type.Object({
	message: Type.String({
		minLength: 1,
		description: "What the reader sees, written in full — this text is the message, not a note about it",
	}),
	to: Type.Optional(
		Type.Object(
			{
				connector: Type.String({ description: "the connector to send to, as the operator names it" }),
				conversation: Type.String({ description: "the external conversation id on that connector" }),
			},
			{
				description:
					"Where to send when this turn has no origin — a scheduled routine naming the chat it reports to. Omit it to answer whoever started the turn.",
			},
		),
	),
});

/**
 * What a script is told instead of a delivery nobody would see: what happened, and what to do about it. Code mode turns
 * an error result into a rejection (`vendor/pi/packages/durable/src/codemode/codemode.ts:280-291`), so the text has to
 * say the call rejects — a script that read it as advice would carry on believing the reader had been written to.
 */
const REPLY_NESTED_REFUSAL =
	"reply cannot deliver from inside a script: the call rejects, and a message sent by a nested call never reaches the reader. Catch it, return the text from the script, and call reply from the turn.";

/** What the model is told when nothing that carries words started this turn and it named no target. */
const NOBODY_REACHED =
	"recorded, but nobody was reached: this turn came from an event hook with no conversation behind it and no target was named, so the message is in the transcript and no person was sent it. To reach someone, call reply again with {to:{connector, conversation}} naming a configured user-face connector and one of its permitted conversations.";

/** Where a reply goes, and whether the recording of it is also a delivery. */
interface ChosenTarget {
	readonly target?: ReplyTarget;
	/** A hooked turn with no origin: the words are recorded, and no medium carries them. */
	readonly nobodyReached?: true;
}

/** The text of a message: a plain string, or its text blocks joined. Reasoning and calls are not text. */
function textOf(message: Message): string {
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

export const replyTool = defineTool({
	name: REPLY_TOOL,
	description:
		"Send the reader a message. This is the only way words reach a person: everything else written in a turn is working notes. A reply goes back where the turn came from — the connector that carried the words, or the transcript itself — so never try to reach a chat by another tool's name. When the turn came from an event hook with no conversation behind it, name the target with {to:{connector, conversation}}, or the message is recorded and nobody is reached. Call this directly, never from inside a script. The turn continues after the call, so send a note when you have news and the result when you have it — never the same words twice.",
	parameters: ReplyParams,
	replay: "unsafe",
	execute: async ({ message, to }, api, context) => {
		const nested = nestedRefusal(api, REPLY_NESTED_REFUSAL);
		if (nested !== undefined) return nested;
		const origin = await readTurnOrigin(api, context);
		const chosen = chooseTarget(origin, to);
		if ("reason" in chosen) return { output: [{ type: "text", text: chosen.reason }] };
		const blocks: Array<{ type: "text"; text: string }> = [{ type: "text", text: message }];
		const record: ReplyRecord = {
			deliveryId: `reply:${api.callId}`,
			blocks,
			...(chosen.target === undefined ? {} : { target: chosen.target }),
			...(origin.kind !== "local" && origin.origin !== undefined ? { origin: origin.origin } : {}),
		};
		// The commit is the delivery, and the commit is what makes it durable: a locale reply is read out of this entry,
		// and a connector reply is sent from it by the outbox, which records the acknowledgement as its own entry.
		await api.commit(
			(tx) =>
				tx.appendEntry(api.conversationId, {
					kind: REPLY_ENTRY_KIND,
					// Plain JSON, field by field: a protocol interface has no index signature, and an entry's `data` is JSON.
					data: {
						deliveryId: record.deliveryId,
						blocks,
						...(record.target === undefined
							? {}
							: {
									target: {
										connector: record.target.connector,
										externalConversationId: record.target.externalConversationId,
									},
								}),
						...(record.origin === undefined
							? {}
							: {
									origin: {
										connector: record.origin.connector,
										externalConversationId: record.origin.externalConversationId,
										...(record.origin.externalMessageId === undefined
											? {}
											: { externalMessageId: record.origin.externalMessageId }),
										...(record.origin.externalActorId === undefined
											? {}
											: { externalActorId: record.origin.externalActorId }),
									},
								}),
					},
				}),
			context,
		);
		const outcome = chosen.nobodyReached === true ? NOBODY_REACHED : outcomeText(record);
		return { output: [{ type: "text", text: outcome }], details: { length: message.length } };
	},
});

/** What the model is told the call did, in one sentence it can act on. */
function outcomeText(record: ReplyRecord): string {
	if (record.target === undefined) {
		return record.origin === undefined
			? "delivered to the transcript"
			: "delivered to the transcript: this turn's origin is a connector, but the reply was addressed here";
	}
	return `queued for delivery to ${record.target.connector} "${record.target.externalConversationId}"`;
}

/**
 * Where the reply goes, or why it cannot go anywhere.
 *
 * The origin decides unless the model named a target: a routine has no origin, and an explicit target that the operator
 * did not grant is refused rather than silently redirected to a room the connector may not speak in.
 */
function chooseTarget(
	origin: TurnOrigin,
	to: { readonly connector: string; readonly conversation: string } | undefined,
): ChosenTarget | { readonly reason: string } {
	if (to !== undefined) {
		const target: ReplyTarget = { connector: to.connector, externalConversationId: to.conversation };
		const reachable = reachableTarget(currentIntegrations(), target);
		if (!reachable.ok) return { reason: `cannot deliver: ${reachable.reason}` };
		return { target };
	}
	// A person's words through a connector and a fire that named its conversation are the same destination: both carry an
	// origin, and the reply goes back to it.
	const carried = origin.kind === "local" ? undefined : origin.origin;
	if (carried !== undefined) {
		const target = targetOfOrigin(carried);
		const reachable = reachableTarget(currentIntegrations(), target);
		// A connector that was switched off mid-turn is not a destination; the reply is still the turn's answer, so the call
		// fails with a sentence the model can act on rather than silently landing somewhere nobody reads.
		return reachable.ok ? { target } : { reason: `cannot deliver: ${reachable.reason}` };
	}
	if (origin.kind === "local") return {};
	return { nobodyReached: true };
}

const DELIVERED = "delivery.delivered";
const REMINDED = "delivery.reminded";

/**
 * The reader never gets silence for an answer.
 *
 * `reply` is a tool, so calling it is the model's choice, and the prompt that asks for it is advice. This gate is what
 * makes it happen: when a turn is about to end with nothing delivered, the run continues with one reminder, and the
 * model gets one more chance to say what it meant to say. Once per turn, because the reminder is itself a `pi.user`
 * entry and the next generation can see it; a second silent answer is left to the projection, which shows a notice
 * rather than nothing.
 *
 * "Delivered" is the same call `reply` makes: one operation, so the gate and the tool cannot disagree about what
 * reaching the reader means.
 */
function turnDelivered(messages: readonly Message[]): boolean {
	const delivering = new Set([REPLY_TOOL]);
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			const call = part as { type?: unknown; name?: unknown };
			if (call.type === "toolCall" && typeof call.name === "string" && delivering.has(call.name)) return true;
		}
	}
	return false;
}

/** Whether this turn has already been reminded: the nudge is the newest user message, and nothing delivered followed. */
function remindedAlready(messages: readonly Message[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as Message;
		if (message.role !== "user") continue;
		return isDeliveryReminder(textOf(message));
	}
	return false;
}

export const deliveryGate = hook(GenerationTask, {
	beforeRequest: async ({ messages }, api, context) => {
		if (turnDelivered(messages)) await api.memo(DELIVERED, true, context);
		if (remindedAlready(messages)) await api.memo(REMINDED, true, context);
		return undefined;
	},
	onYield: async (_answer, api, context) => {
		if ((await api.memo(DELIVERED, context)) === true) return undefined;
		if ((await api.memo(REMINDED, context)) === true) return undefined;
		return { continue: DELIVERY_REMINDER };
	},
});

export const Delivery = defineExtension({
	name: "delivery",
	tools: [replyTool],
	hooks: [deliveryGate],
});
