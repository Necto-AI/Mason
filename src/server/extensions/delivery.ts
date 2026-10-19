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
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export const SendToUserParams = Type.Object({
	message: Type.String({
		minLength: 1,
		description: "What the user reads, written in full — this text is the message, not a note about it",
	}),
});

export const sendToUserTool = defineTool({
	name: "send_to_user",
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

export const Delivery = defineExtension({
	name: "delivery",
	tools: [sendToUserTool],
});
