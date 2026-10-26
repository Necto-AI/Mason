/**
 * `send_to_user`: the one channel through which the agent's words reach the reader — in the console.
 *
 * The tool performs no side effect and is not terminal. Delivery is defined as the call being committed to the
 * transcript: the chat renders the message out of the `pi.assistant` / `pi.tool-result` entries, so `execute()` only
 * has to return. The turn carries on afterwards, which lets the model send a progress note and then the result in
 * the same turn.
 *
 * There are two readers, and this tool is one of them. In the console, `send_to_user` *is* the reader: nothing else the
 * model writes is rendered, so a call is the message. A turn an event hook started is the other case — the person is in
 * a chat, the hook's instruction answers there with the integration's own tool, and `send_to_user` writes into a console
 * that person is not looking at. The projection renders such a call, so nothing about it is a lie in the transcript, and
 * that is exactly what made it dangerous: the model was told "delivered", wrote itself a note that it had answered, and
 * the person in the chat heard nothing at all. A prompt cannot fix that — the tool's description wins — so `execute()`
 * refuses it in a hooked turn, naming the tool that does reach the reader, and the gate below counts that tool as the
 * delivery instead. Which tool that is comes from the hook's own instruction (`hooks.ts`), one source for both.
 *
 * Delivery is a top-level act, because the projection renders a message only out of a call the model made itself. A
 * call made from inside another tool — `tools.send_to_user()` in a code-mode script — is a nested call whose result
 * goes back to the script instead of into the transcript. Nothing about it reaches the reader, yet the script would be
 * told "delivered" and go on as if the reader had the message: the turn ends with the projection's "The agent finished
 * without sending you a message." notice, which is the truth discovered too late. So `execute()` refuses one, with the
 * instruction that puts the message where the reader is.
 *
 * `replay` is set explicitly, though `"unsafe"` is pi's default: re-running an interrupted call after a restart would
 * deliver the same message twice. An interrupted call is never re-executed — it settles as an `interrupted` error
 * result, which the client shows as a bubble that may not have reached the reader.
 */
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	type Cursor,
	defineExtension,
	defineTool,
	type EntryRecord,
	GenerationTask,
	hook,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
	DELIVERY_REMINDER,
	hookDeliveryReminder,
	isDeliveryReminder,
	MESSAGE_TOOL,
	WIDGET_TOOL,
} from "../../shared/contract.ts";
import { deliveryToolForTurn, isHookTurn } from "../hooks.ts";
import { isNestedCall, nestedRefusal, refusal } from "./nested.ts";

const SendToUserParams = Type.Object({
	message: Type.String({
		minLength: 1,
		description: "What the user reads, written in full — this text is the message, not a note about it",
	}),
});

/**
 * What a script is told instead of a delivery nobody would see: what happened, and what to do about it. Code mode turns
 * an error result into a rejection (`vendor/pi/packages/durable/src/codemode/codemode.ts:280-291`), so the text has to
 * say the call rejects — a script that read it as advice would carry on believing the reader had been written to.
 */
const DELIVERY_NESTED_REFUSAL =
	"send_to_user cannot deliver from inside a script: the call rejects, and a message sent by a nested call never reaches the reader. Catch it, return the text from the script, and send it with send_to_user directly.";

/**
 * What the model is told instead of a delivery nobody would see, in a turn an event hook started: the same shape as the
 * nested refusal — the call rejects, here is who was never reached, here is the call that reaches them — with `tool` as
 * the one the hook's own instruction names.
 *
 * It has to say "rejects" for the same reason the nested one does: code mode turns an error result into a rejection, and
 * a script that read it as advice would carry on believing the chat had the answer.
 */
function hookRefusal(tool: string, nested: boolean): string {
	const fromScript = nested
		? ` A message sent from inside a script reaches nobody in either case: return the text from the script and call ${tool} from the turn.`
		: "";
	return `send_to_user cannot reach the reader in this turn: the call rejects, and a message sent this way never arrives. This turn came from an event hook, and the person it answers sees only what \`${tool}\` sends: call ${tool} directly, with the chat the payload names, and put the answer in that call.${fromScript}`;
}

/**
 * What the model is told when a hook turn has no chat on the other end — a schedule, a repository event, a retry.
 *
 * `send_to_user` is a real delivery here: the console is the only reader such a turn has, and the call is committed.
 * Saying just "delivered" would be true and misleading in the same breath — nobody is in a chat, so the answer waits in
 * the transcript until somebody opens it. The sentence names that, and it names the fix a person can act on.
 */
const CONSOLE_ONLY_DELIVERY =
	"delivered to the operator console. This turn came from an event hook whose instruction names no chat tool, so no message reached a person: the answer is in the transcript, and it is read when somebody opens the console.";

export const sendToUserTool = defineTool({
	name: MESSAGE_TOOL,
	description:
		"Send the user a message in the operator console. Only messages sent this way are seen there; everything else you write in a turn is working notes. In a turn an event hook started, the person is in a chat reached by that chat's own tool, and this call is refused; a hook whose instruction names no chat tool — a schedule, a repository event — has no other reader, so the call lands here and the result says so. Call this directly, never from inside a script: a message sent by a nested call never reaches the reader. The turn continues after the call, so send a note when you have news and the result when you have it — never the same words twice.",
	parameters: SendToUserParams,
	replay: "unsafe",
	// The commit is the delivery: nothing to do, so nothing to undo, retry or wait for. A nested call has nothing to
	// commit at all, which is why it is answered with the instruction rather than with "delivered".
	execute: async ({ message }, api, context) => {
		// Which reader this turn has, read from the transcript rather than from anything the model was asked to do.
		const input = await turnInput(api, context);
		const reader = deliveryToolForTurn(input);
		if (reader !== undefined) return refusal(hookRefusal(reader, isNestedCall(api)));
		const nested = nestedRefusal(api, DELIVERY_NESTED_REFUSAL);
		if (nested !== undefined) return nested;
		// A console turn and a hooked turn with no chat both land in the transcript; only the second is worth saying out
		// loud, because "delivered" there reads as "a person has this" and nobody does.
		const text = isHookTurn(input) ? CONSOLE_ONLY_DELIVERY : "delivered";
		return { output: [{ type: "text", text }], details: { length: message.length } };
	},
});

/** How far back a turn's input can be — a round of tool calls is one entry each, and a page always ends. */
const TURN_INPUT_PAGE = 128;
const TURN_INPUT_MAX_PAGES = 16;

/**
 * The input that started this turn, as the model was given it: the newest user message in the transcript, unless that is
 * the gate's own reminder, which starts nothing.
 *
 * A tool cannot see the request that made its call, so this reads the transcript instead — the same texts the gate reads
 * in `beforeRequest`, which is what keeps the two from disagreeing about who the reader is. It is a read-only commit: no
 * entry is written, and `Session.commit()` discards a batch with no writes.
 */
async function turnInput(api: ToolExecutionApi, context: Context): Promise<string | undefined> {
	const conversationId: ConversationId = api.conversationId;
	return api.commit(async (tx) => {
		let cursor: Cursor | undefined;
		for (let page = 0; page < TURN_INPUT_MAX_PAGES; page += 1) {
			const scanned = await tx.scanEntries({ conversationId, order: "descending" }, TURN_INPUT_PAGE, cursor);
			for (const entry of scanned.items) {
				const spoken = inputTextOf(entry);
				if (spoken === undefined || isDeliveryReminder(spoken)) continue;
				return spoken;
			}
			if (scanned.next === undefined) return undefined;
			cursor = scanned.next;
		}
		return undefined;
	}, context);
}

/** What an entry contributes as input, or `undefined` when it is not a user message: a resumed turn has older ones. */
function inputTextOf(entry: EntryRecord): string | undefined {
	for (const message of entry.model ?? []) {
		if (message.role !== "user") continue;
		return textOf(message);
	}
	return undefined;
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

/**
 * What the turn did so far, read from the only thing a hook can see: the model's own context.
 *
 * A generation is one request and the round it starts, so a turn that makes several rounds is several generations and
 * no memo survives between them. The message list does survive, so the turn is read from it: everything after the last
 * real input is this turn, and a call in it is something the reader has already seen — the reader being whoever the
 * turn's input says they are. A turn an event hook started has a chat on the other end, reached by that hook's own tool
 * (`tool`), and `send_to_user` writes to the console instead: there, only that tool is a delivery.
 */
function turnProgress(messages: readonly Message[]): { delivered: boolean; reminded: boolean; tool?: string } {
	// Walk back to the input that started the turn; the reminder is not one, or the turn would look like it restarted
	// the moment it was nudged.
	let start = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as Message;
		if (message.role === "user" && !isDeliveryReminder(textOf(message))) {
			start = index;
			break;
		}
	}
	// The hook this turn answers, if it answers one: the one source of truth for which tool delivers here.
	const tool = deliveryToolForTurn(start === -1 ? undefined : textOf(messages[start] as Message));
	// No input in context at all — a resumed or compacted turn: read what is there, and err towards having delivered.
	// `send_to_user` reads the same fallback off the same transcript (`turnInput`), so a turn whose input was compacted
	// away is read as the console's by both of them, together, rather than by one of them.
	const delivering = new Set(tool === undefined ? [MESSAGE_TOOL, WIDGET_TOOL] : [tool]);

	let delivered = false;
	let reminded = false;
	for (let index = start + 1; index < messages.length; index += 1) {
		const message = messages[index] as Message;
		if (message.role === "user") {
			if (isDeliveryReminder(textOf(message))) reminded = true;
			continue;
		}
		if (message.role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			const call = part as { type?: unknown; name?: unknown };
			if (call.type === "toolCall" && typeof call.name === "string" && delivering.has(call.name)) delivered = true;
		}
	}
	return { delivered, reminded, ...(tool === undefined ? {} : { tool }) };
}

const DELIVERED = "delivery.delivered";
const REMINDED = "delivery.reminded";
/** The hook's own tool, when this turn answers one: what the reminder names instead of `send_to_user`. */
const TOOL = "delivery.tool";

/**
 * The reader never gets silence for an answer.
 *
 * `send_to_user` is a tool, so calling it is the model's choice, and the prompt that asks for it is advice. This gate is
 * what makes it happen: when a turn is about to end with nothing delivered, the run continues with one reminder,
 * and the model gets one more chance to say what it meant to say. Once per turn, because the reminder is itself a
 * `pi.user` entry and the next generation can see it; a second silent answer is left to the projection, which shows a
 * notice rather than nothing.
 *
 * What counts as delivered is the turn's reader, not a name written here: in the console it is `send_to_user`, and in a
 * turn an event hook started it is the tool that hook's instruction names. The reminder says the same thing, so a nudge
 * is never an instruction to call the tool that cannot arrive.
 *
 * Every delivery this walk can see is one the reader can see, because a nested one is refused: the gate and the
 * projection read the same top-level call.
 */
export const deliveryGate = hook(GenerationTask, {
	beforeRequest: async ({ messages }, api, context) => {
		const progress = turnProgress(messages);
		if (progress.delivered) await api.memo(DELIVERED, true, context);
		if (progress.reminded) await api.memo(REMINDED, true, context);
		if (progress.tool !== undefined) await api.memo(TOOL, progress.tool, context);
		return undefined;
	},
	onYield: async (_answer, api, context) => {
		if ((await api.memo(DELIVERED, context)) === true) return undefined;
		if ((await api.memo(REMINDED, context)) === true) return undefined;
		const tool = await api.memo(TOOL, context);
		return { continue: typeof tool === "string" ? hookDeliveryReminder(tool) : DELIVERY_REMINDER };
	},
});

export const Delivery = defineExtension({
	name: "delivery",
	tools: [sendToUserTool],
	hooks: [deliveryGate],
});
