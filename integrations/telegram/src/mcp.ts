/**
 * The tools face: three tools, and all of them verbs the agent needs to answer a message.
 *
 * `send_message` and `send_file` are the two ways this container writes to Telegram, and `list_chats` is how the agent
 * learns an id without a human pasting one: a payload carries the chat id, and the list is the fallback for a chat that
 * has not spoken since the agent started. Nothing else is offered: a delete or an admin call would each be a second thing
 * to gate, and neither of them is what "answer the team" needs.
 *
 * `send_file` takes a path and nothing else, and the path has to be in the inbox (`src/send-file.ts`): the volume the
 * relay and the tool machine share is the whole of what may cross, so a file the agent wants to send is a file it has
 * written there first. Every refusal is one sentence in the tool result, because the model is the reader and can only fix
 * a path, a caption or a size it is told about.
 *
 * Each description is the one line the model reads, and it says what the tool does rather than how the vendor's API
 * works — mason builds the tool name (`mcp__telegram__send_message`) and the deferred list from exactly this text.
 *
 * The tools are wired to injected functions rather than to a `TelegramApi`: the MCP layer is the part with a protocol to
 * test, and a test drives the whole server through an in-memory transport with a fake send behind it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_CAPTION, prepareSendFile } from "./send-file.ts";
import type { SeenChat } from "./state.ts";
import type { SendFileOptions, SendOutcome } from "./telegram.ts";

/** Declared to the client on `initialize`. Kept equal to `package.json`, which this file cannot import at runtime. */
const SERVER_NAME = "mason-telegram";
const SERVER_VERSION = "0.1.0";

/** What the tools need from the rest of the container. */
export interface TelegramTools {
	/** Send through the per-chat queue, so the limit and a 429 are the queue's problem, not the model's. */
	readonly send: (options: {
		readonly chatId: string;
		readonly text: string;
		readonly replyToMessageId?: number;
	}) => Promise<SendOutcome>;
	/** Send a file the same way a message goes: the upload is charged to the chat's own minute. */
	readonly sendFile: (options: SendFileOptions) => Promise<SendOutcome>;
	/**
	 * The one directory a file may be sent from: the volume the relay shares with the tool machine, and the only part of
	 * the agent's home this container can read.
	 */
	readonly inboxDir: string;
	/** The chats the poller has seen, newest last. */
	readonly chats: () => readonly SeenChat[];
	/**
	 * The typing indicator, told a chat has an answer on the way. The dots are the poller's to start (it knows a message
	 * became a fire) and this face's to stop: an answer that has arrived replaces them, and one that failed is not worth
	 * a chat that keeps saying "typing…".
	 */
	readonly typing?: { stop(chatId: string): void };
}

export function createMcpServer(tools: TelegramTools): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

	server.registerTool(
		"send_message",
		{
			description: "Send a message to a Telegram chat, and return the id of the message it created.",
			inputSchema: {
				chat_id: z.string().describe("The chat to write in: an id from a message or from list_chats."),
				text: z.string().describe("What to say. Plain text, as it should read in the chat."),
				reply_to_message_id: z
					.number()
					.int()
					.optional()
					.describe("The message this answers, to keep the reply attached to it."),
			},
		},
		async ({ chat_id, text, reply_to_message_id }) => {
			tools.typing?.stop(chat_id);
			const outcome = await tools.send({
				chatId: chat_id,
				text,
				...(reply_to_message_id === undefined ? {} : { replyToMessageId: reply_to_message_id }),
			});
			if (outcome.kind === "sent") return sentContent(chat_id, outcome.messageId);
			return toolError(`Message not sent: ${whyNot(outcome)}`);
		},
	);

	server.registerTool(
		"send_file",
		{
			description:
				"Send a file that is in the inbox to a Telegram chat: a photo (png, jpg, jpeg, webp) renders in the chat, anything else arrives as a download.",
			inputSchema: {
				chat_id: z.string().describe("The chat to send it to: an id from a message or from list_chats."),
				path: z
					.string()
					.describe(
						`The absolute path of the file in the inbox at ${tools.inboxDir}; a file anywhere else is not sent.`,
					),
				caption: z
					.string()
					.optional()
					.describe(`What to say beside it, up to ${MAX_CAPTION} characters. Left out, the file arrives alone.`),
			},
		},
		async ({ chat_id, path, caption }) => {
			tools.typing?.stop(chat_id);
			const prepared = await prepareSendFile({
				dir: tools.inboxDir,
				path,
				...(caption === undefined ? {} : { caption }),
			});
			if (prepared.kind === "refused") return toolError(`File not sent: ${prepared.reason}`);
			const outcome = await tools.sendFile({
				chatId: chat_id,
				bytes: prepared.file.bytes,
				name: prepared.file.name,
				kind: prepared.file.kind,
				...(caption === undefined ? {} : { caption }),
			});
			if (outcome.kind === "sent") return sentContent(chat_id, outcome.messageId);
			return toolError(`File not sent: ${whyNot(outcome)}`);
		},
	);

	server.registerTool(
		"list_chats",
		{
			description: "List the Telegram chats this bot has seen a message in, with the id to write back to.",
		},
		async () => ({
			content: [{ type: "text", text: JSON.stringify(tools.chats()) }],
		}),
	);

	return server;
}

/** The one shape a landed send answers with, the same for a message and a file: the ids the model can quote back. */
function sentContent(chatId: string, messageId: number) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ chat_id: chatId, message_id: messageId }) }],
	};
}

/** A tool result that says what did not happen: the model reads it, and the chat never does. */
function toolError(text: string) {
	return { isError: true, content: [{ type: "text" as const, text }] };
}

/** Why a send did not land, in the words the model can act on. */
function whyNot(outcome: Exclude<SendOutcome, { readonly kind: "sent" }>): string {
	return outcome.kind === "throttled" ? `Telegram is throttling this chat (${outcome.retryAfter} s)` : outcome.error;
}
