/**
 * `send_to_user`: the one channel through which the agent's words reach the reader.
 *
 * The tool performs no side effect and is not terminal. Delivery is defined as the call being committed to the
 * transcript: the chat renders the message out of the `pi.assistant` / `pi.tool-result` entries, so `execute()` only
 * has to return. The turn carries on afterwards, which lets the model send a progress note and then the result in
 * the same turn.
 *
 * `replay` is set explicitly, though `"unsafe"` is pi's default: re-running an interrupted call after a restart would
 * deliver the same message twice. An interrupted call is never re-executed — it settles as an `interrupted` error
 * result, which the client shows as a bubble that may not have reached the reader.
 */
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DELIVERY_REMINDER, MESSAGE_TOOL, WIDGET_TOOL } from "../../shared/contract.ts";

const SendToUserParams = Type.Object({
	message: Type.String({
		minLength: 1,
		description: "What the user reads, written in full — this text is the message, not a note about it",
	}),
});

export const sendToUserTool = defineTool({
	name: MESSAGE_TOOL,
	description:
		"Send the user a message. Only messages sent this way are seen by the user; everything else you write in a turn is working notes. The turn continues after the call, so send a note when you have news and the result when you have it — never the same words twice.",
	parameters: SendToUserParams,
	replay: "unsafe",
	// The commit is the delivery: nothing to do, so nothing to undo, retry or wait for.
	execute: async ({ message }) => ({
		output: [{ type: "text", text: "delivered" }],
		details: { length: message.length },
	}),
});


/**
 * What the turn did so far, read from the only thing a hook can see: the model's own context.
 *
 * A generation is one request and the round it starts, so a turn that makes several rounds is several generations and
 * no memo survives between them. The message list does survive, so the turn is read from it: everything after the last
 * real input is this turn, and a `send_to_user` or widget call in it is something the reader has already seen.
 */
function turnProgress(messages: readonly Message[]): { delivered: boolean; reminded: boolean } {
	const reminder = DELIVERY_REMINDER.trim();
	const text = (message: Message): string => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => {
				const block = part as { type?: unknown; text?: unknown };
				return block.type === "text" && typeof block.text === "string" ? block.text : "";
			})
			.join("");
	};
	// Walk back to the input that started the turn; the reminder is not one, or the turn would look like it restarted
	// the moment it was nudged.
	let start = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as Message;
		if (message.role === "user" && text(message).trim() !== reminder) {
			start = index;
			break;
		}
	}
	// No input in context at all — a resumed or compacted turn: read what is there, and err towards having delivered.

	let delivered = false;
	let reminded = false;
	for (let index = start + 1; index < messages.length; index += 1) {
		const message = messages[index] as Message;
		if (message.role === "user") {
			if (text(message).trim() === reminder) reminded = true;
			continue;
		}
		if (message.role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			const call = part as { type?: unknown; name?: unknown };
			if (call.type === "toolCall" && (call.name === MESSAGE_TOOL || call.name === WIDGET_TOOL)) delivered = true;
		}
	}
	return { delivered, reminded };
}

const DELIVERED = "delivery.delivered";
const REMINDED = "delivery.reminded";

/**
 * The reader never gets silence for an answer.
 *
 * `send_to_user` is a tool, so calling it is the model's choice, and the prompt that asks for it is advice. This gate is
 * what makes it happen: when a turn is about to end with nothing delivered, the run continues with one reminder,
 * and the model gets one more chance to say what it meant to say. Once per turn, because the reminder is itself a
 * `pi.user` entry and the next generation can see it; a second silent answer is left to the projection, which shows a
 * notice rather than nothing.
 */
export const deliveryGate = hook(GenerationTask, {
	beforeRequest: async ({ messages }, api, context) => {
		const progress = turnProgress(messages);
		if (progress.delivered) await api.memo(DELIVERED, true, context);
		if (progress.reminded) await api.memo(REMINDED, true, context);
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
	tools: [sendToUserTool],
	hooks: [deliveryGate],
});
