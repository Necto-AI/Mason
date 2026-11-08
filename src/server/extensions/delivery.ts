/**
 * `send`: the one channel through which a turn's words reach a reader.
 *
 * Routing is mason's, not the model's. A turn knows its origin from the transcript — the `app.connector` or `app.hook`
 * entry that started it — and the tool addresses the send there. There is no vendor tool to name and no prompt that
 * names one: a chat, the transcript and a schedule are the same call, and only the destination differs.
 *
 * Three outcomes, and the result says which:
 *
 * - **delivered** — the transcript is the reader; the entry the call commits *is* the delivery.
 * - **queued** — a connector is the reader; the entry is the durable outbox, and the link delivers it, resends it after a
 *   reconnect, and records the acknowledgement. Saying "delivered" here would be a promise this process cannot keep.
 * - **nobody reached** — an event with no origin that named no address. The work is recorded and the model is told that
 *   no person has it, which is the truth; a message nobody received is the worst outcome the arrangement exists to avoid.
 *
 * `replay` is explicit, though `"unsafe"` is pi's default: re-running an interrupted call after a restart would commit
 * the same message twice. An interrupted call is never re-executed — it settles as an `interrupted` error result, which
 * the client shows as a bubble that may not have reached the reader.
 *
 * The extension carries a second gate over the same lifecycle plumbing, because a turn has two endings and both are
 * about what it leaves behind: the delivery gate, and the reflection gate that asks a turn of ten tool rounds or more
 * what it kept. One continuation each, in the turn that did the work, and no second model.
 *
 * A **nested** call — `tools.send()` inside a code-mode script — is refused: its result goes back to the script instead
 * of into the transcript, so nothing reaches the reader while the script is told it did. The entry is the delivery, and
 * a script cannot write one that a reader sees; the refusal says what to do instead.
 */
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook } from "@earendil-works/pi-durable";
import { parseSendAddress, sendAddress } from "mason-protocol";
import { Type } from "typebox";
import {
	DELIVERY_REMINDER,
	isDeliveryReminder,
	isReflectionAsk,
	REFLECTION_ASK,
	REPLY_ENTRY_KIND,
	SEND_TOOL,
} from "../../shared/contract.ts";
import { currentIntegrations } from "../integrations.ts";
import {
	addressOfOrigin,
	type ReplyRecord,
	reachableAddress,
	readTurnOrigin,
	type SendAddress,
	type TurnOrigin,
} from "../replies.ts";
import { nestedRefusal } from "./nested.ts";

const SendParams = Type.Object({
	text: Type.String({
		minLength: 1,
		description: "What the reader sees, written in full — this text is the message, not a note about it",
	}),
	to: Type.Optional(
		Type.String({
			description:
				'Where to send when this turn has no origin, as "<connector>/<target>" out of the addresses you were told about — a scheduled routine naming the chat it reports to. Omit it to answer whoever started the turn.',
		}),
	),
});

/**
 * What a script is told instead of a delivery nobody would see: what happened, and what to do about it. Code mode turns
 * an error result into a rejection (`vendor/pi/packages/durable/src/codemode/codemode.ts:280-291`), so the text has to
 * say the call rejects — a script that read it as advice would carry on believing the reader had been written to.
 */
const SEND_NESTED_REFUSAL =
	"send cannot deliver from inside a script: the call rejects, and a message sent by a nested call never reaches the reader. Catch it, return the text from the script, and call send from the turn.";

/** What the model is told when nothing that carries words started this turn and it named no address. */
const NOBODY_REACHED =
	'recorded, but nobody was reached: this turn came from an event with no address behind it and no target was named, so the message is in the transcript and no person was sent it. To reach someone, call send again with {to:"<connector>/<target>"} naming one of the addresses you were told about.';

/** Where a send goes, and whether the recording of it is also a delivery. */
interface ChosenAddress {
	readonly address?: SendAddress;
	/** An event with no origin: the words are recorded, and no medium carries them. */
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

export const sendTool = defineTool({
	name: SEND_TOOL,
	description: `Send the reader a message. This is the only way words reach a person: everything else written in a turn is working notes. A send goes back where the turn came from — the connector that carried the words, or the transcript itself — so never try to reach a chat by another tool's name. When the turn came from an event with no address behind it, name one with to: "<connector>/<target>", out of the addresses the prompt lists, or the message is recorded and nobody is reached. Call this directly, never from inside a script. The turn continues after the call, so send a note when you have news and the result when you have it — never the same words twice.`,
	parameters: SendParams,
	replay: "unsafe",
	execute: async ({ text, to }, api, context) => {
		const nested = nestedRefusal(api, SEND_NESTED_REFUSAL);
		if (nested !== undefined) return nested;
		const origin = await readTurnOrigin(api, context);
		const chosen = chooseAddress(origin, to);
		if ("reason" in chosen) return { output: [{ type: "text", text: chosen.reason }] };
		const blocks: Array<{ type: "text"; text: string }> = [{ type: "text", text }];
		const record: ReplyRecord = {
			deliveryId: `reply:${api.callId}`,
			blocks,
			...(chosen.address === undefined ? {} : { address: chosen.address }),
			...(origin.kind !== "local" && origin.origin !== undefined ? { origin: origin.origin } : {}),
		};
		// The commit is the delivery, and the commit is what makes it durable: a local send is read out of this entry,
		// and a connector send is delivered from it by the outbox, which records the acknowledgement as its own entry.
		await api.commit(
			(tx) =>
				tx.appendEntry(api.conversationId, {
					kind: REPLY_ENTRY_KIND,
					// Plain JSON, field by field: a protocol interface has no index signature, and an entry's `data` is JSON.
					data: {
						deliveryId: record.deliveryId,
						blocks,
						...(record.address === undefined
							? {}
							: {
									target: {
										connector: record.address.connector,
										...(record.address.target === undefined ? {} : { target: record.address.target }),
										...(record.address.ref === undefined ? {} : { ref: record.address.ref }),
									},
								}),
						...(record.origin === undefined
							? {}
							: {
									origin: {
										connector: record.origin.connector,
										ref: record.origin.ref,
										...(record.origin.messageId === undefined ? {} : { messageId: record.origin.messageId }),
										...(record.origin.actor === undefined ? {} : { actor: record.origin.actor }),
									},
								}),
					},
				}),
			context,
		);
		const outcome = chosen.nobodyReached === true ? NOBODY_REACHED : outcomeText(record);
		return { output: [{ type: "text", text: outcome }], details: { length: text.length } };
	},
});

/** What the model is told the call did, in one sentence it can act on. */
function outcomeText(record: ReplyRecord): string {
	if (record.address === undefined) {
		return record.origin === undefined
			? "delivered to the transcript"
			: "delivered to the transcript: this turn's origin is a connector, but the send was addressed here";
	}
	// A target the model named reads back as the address it wrote, so a mistake is visible in the same words it used. An
	// address that came from the turn's origin is the connector alone: the `ref` is opaque, and printing it as if it were
	// a target would teach a name nothing accepts.
	const where =
		record.address.target === undefined
			? record.address.connector
			: sendAddress(record.address.connector, record.address.target);
	return `queued for delivery to ${where}`;
}

/**
 * Where the send goes, or why it cannot go anywhere.
 *
 * The origin decides unless the model named an address: a routine has no origin, and an address the operator did not
 * grant is refused rather than silently redirected to a target the connector may not be sent to.
 */
function chooseAddress(origin: TurnOrigin, to: string | undefined): ChosenAddress | { readonly reason: string } {
	if (to !== undefined && to.trim() !== "") {
		const parsed = parseSendAddress(to.trim());
		if (parsed === undefined) {
			return {
				reason: `cannot deliver: "${to}" is not an address. Write it as "<connector>/<target>", out of the list above.`,
			};
		}
		const address: SendAddress = { connector: parsed.connector, target: parsed.target };
		const reachable = reachableAddress(currentIntegrations(), address);
		if (!reachable.ok) return { reason: `cannot deliver: ${reachable.reason}` };
		return { address };
	}
	// A person's words through a connector and an event that named its address are the same destination: both carry an
	// origin, and the send goes back to it.
	const carried = origin.kind === "local" ? undefined : origin.origin;
	if (carried !== undefined) {
		const address = addressOfOrigin(carried);
		const reachable = reachableAddress(currentIntegrations(), address);
		// A connector that was switched off mid-turn is not a destination; the send is still the turn's answer, so the call
		// fails with a sentence the model can act on rather than silently landing somewhere nobody reads.
		return reachable.ok ? { address } : { reason: `cannot deliver: ${reachable.reason}` };
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
	const delivering = new Set([SEND_TOOL]);
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

const LONG_TURN = "reflection.long";
const ASKED = "reflection.asked";

/** How much work earns the ask: ten tool rounds in one turn, counted rather than offered. */
const REFLECTION_ROUNDS = 10;

/**
 * The turn so far: the messages after the newest input a person or a fire wrote.
 *
 * A continuation is one of the gates' own lines, so it is stepped over rather than taken for a new turn: the ten rounds
 * that earned the ask are still in the turn when the model answers the reminder, and a count that restarted would ask
 * for the extraction only in the turns that never needed rescuing. The run's context is the whole conversation, so the
 * boundary has to be found in it; the memo cannot supply it, because a continuation starts a new generation.
 */
function turnSoFar(messages: readonly Message[]): readonly Message[] {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as Message;
		if (message.role !== "user") continue;
		const text = textOf(message);
		if (isDeliveryReminder(text) || isReflectionAsk(text)) continue;
		return messages.slice(index + 1);
	}
	return messages;
}

/** Whether an assistant message asked for tools: one round of work, which is what the counter counts. */
function carriedCalls(message: Message): boolean {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	return content.some((part) => (part as { type?: unknown }).type === "toolCall");
}

/** Whether the turn has already been asked what to keep: the ending after the ask is not asked again. */
function askedAlready(turn: readonly Message[]): boolean {
	return turn.some((message) => message.role === "user" && isReflectionAsk(textOf(message)));
}

/**
 * A turn of real work ends by keeping what it learned, asked once.
 *
 * The mechanism is the delivery gate's, one counter over: `beforeRequest` reads the turn's progress and memoizes it,
 * `onYield` continues the run with one ask. Not a timer, not a background fork, not a second model: the work is the
 * turn's own context, and the same generation answers it. The ask is a `pi.user` entry, so the projection drops it and
 * the reader sees only the reply that says what was kept.
 *
 * The guards are the ask's wording, and what code can enforce of them is enforced here: writes are the agent's own tools
 * on its own half of the home, so a file outside `agent/` is refused by the tool machine's mount rather than by this
 * gate. A skill description under 60 characters, and a skill retired only by naming what absorbed it, are instructions:
 * there is no `skill_manage` to refuse a malformed one, and ADR 0013 is why there is no gateway to ask.
 */
export const reflectionGate = hook(GenerationTask, {
	beforeRequest: async ({ messages }, api, context) => {
		const turn = turnSoFar(messages);
		if (turn.filter(carriedCalls).length >= REFLECTION_ROUNDS) await api.memo(LONG_TURN, true, context);
		if (askedAlready(turn)) await api.memo(ASKED, true, context);
		return undefined;
	},
	onYield: async (_answer, api, context) => {
		if ((await api.memo(LONG_TURN, context)) !== true) return undefined;
		if ((await api.memo(ASKED, context)) === true) return undefined;
		return { continue: REFLECTION_ASK };
	},
});

export const Delivery = defineExtension({
	name: "delivery",
	tools: [sendTool],
	hooks: [deliveryGate, reflectionGate],
});
