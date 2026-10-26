/**
 * The tools face: two tools, and both of them verbs the agent needs to answer a message.
 *
 * `send_message` is the only way this container writes to Telegram, and `list_chats` is how the agent learns an id
 * without a human pasting one — a payload carries the chat id, and the list is the fallback for a chat that has not
 * spoken since the agent started. Nothing else is offered: a delete, an admin call or a file upload would each be a
 * second thing to gate, and none of them is what "answer the team" needs.
 *
 * Each description is the one line the model reads, and it says what the tool does rather than how the vendor's API
 * works — mason builds the tool name (`mcp__telegram__send_message`) and the deferred list from exactly this text.
 *
 * The tools are wired to injected functions rather than to a `TelegramApi`: the MCP layer is the part with a protocol to
 * test, and a test drives the whole server through an in-memory transport with a fake send behind it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SeenChat } from "./state.ts";
import type { SendOutcome } from "./telegram.ts";

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
			if (outcome.kind === "sent") {
				return {
					content: [{ type: "text", text: JSON.stringify({ chat_id, message_id: outcome.messageId }) }],
				};
			}
			const error = outcome.kind === "throttled" ? `Telegram is throttling this chat (${outcome.retryAfter} s)` : outcome.error;
			return { isError: true, content: [{ type: "text", text: `Message not sent: ${error}` }] };
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
