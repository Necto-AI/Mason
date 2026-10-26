/**
 * The tools face over the real protocol, with no socket in it.
 *
 * A client and a server joined by the SDK's in-memory transport: `tools/list` is answered by the same code mason's
 * `McpClient` talks to over HTTP, and `tools/call` reaches a fake `send` instead of Telegram. That is the closest a test
 * gets to what mason will do at boot without binding a port, and it is enough to pin the two things that can be wrong
 * here — the surface being bigger than two tools, and an argument not reaching the call that uses it.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, it } from "node:test";
import { createMcpServer, type TelegramTools } from "../src/mcp.ts";
import type { SeenChat } from "../src/state.ts";
import type { SendOutcome } from "../src/telegram.ts";

interface Call {
	readonly chatId: string;
	readonly text: string;
	readonly replyToMessageId: number | undefined;
}

interface Rig {
	readonly client: Client;
	readonly calls: Call[];
	readonly chats: SeenChat[];
	close(): Promise<void>;
}

async function connect(
	options: { readonly outcome?: SendOutcome; readonly chats?: SeenChat[] } = {},
): Promise<Rig> {
	const calls: Call[] = [];
	const chats = options.chats ?? [];
	const tools: TelegramTools = {
		send: async (request) => {
			calls.push({ chatId: request.chatId, text: request.text, replyToMessageId: request.replyToMessageId });
			return options.outcome ?? { kind: "sent", messageId: 4_242 };
		},
		chats: () => chats,
	};
	const server = createMcpServer(tools);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "mason", version: "0.1.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return {
		client,
		calls,
		chats,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

describe("the tools face", () => {
	it("offers exactly send_message and list_chats, and nothing else", async () => {
		const rig = await connect();
		try {
			const { tools } = await rig.client.listTools();
			assert.deepEqual(
				tools.map((tool) => tool.name).sort(),
				["list_chats", "send_message"],
			);
			// One line each: the description is text the model reads, and a paragraph there is context nobody asked for.
			for (const tool of tools) {
				assert.equal(typeof tool.description, "string");
				assert.ok(!(tool.description ?? "").includes("\n"), `${tool.name} has a multi-line description`);
			}
		} finally {
			await rig.close();
		}
	});

	it("describes send_message's arguments so a model can fill them without guessing", async () => {
		const rig = await connect();
		try {
			const { tools } = await rig.client.listTools();
			const send = tools.find((tool) => tool.name === "send_message");
			const schema = send?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
			assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
				"chat_id",
				"reply_to_message_id",
				"text",
			]);
			assert.deepEqual(schema.required, ["chat_id", "text"]);
		} finally {
			await rig.close();
		}
	});

	it("maps send_message's arguments onto the Telegram call and returns the message id", async () => {
		const rig = await connect();
		try {
			const result = await rig.client.callTool({
				name: "send_message",
				arguments: { chat_id: "-1001234", text: "on it", reply_to_message_id: 77 },
			});

			assert.deepEqual(rig.calls, [{ chatId: "-1001234", text: "on it", replyToMessageId: 77 }]);
			const content = result.content as { type: string; text?: string }[];
			assert.deepEqual(JSON.parse(content[0]?.text ?? ""), { chat_id: "-1001234", message_id: 4_242 });
		} finally {
			await rig.close();
		}
	});

	it("leaves the reply out when there is none", async () => {
		const rig = await connect();
		try {
			await rig.client.callTool({ name: "send_message", arguments: { chat_id: "4711", text: "hi" } });
			assert.deepEqual(rig.calls, [{ chatId: "4711", text: "hi", replyToMessageId: undefined }]);
		} finally {
			await rig.close();
		}
	});

	it("reports a refused send as a tool error with Telegram's own reason", async () => {
		const rig = await connect({ outcome: { kind: "failed", error: "400 Bad Request: chat not found" } });
		try {
			const result = await rig.client.callTool({
				name: "send_message",
				arguments: { chat_id: "-1001234", text: "on it" },
			});

			assert.equal(result.isError, true);
			const content = result.content as { type: string; text?: string }[];
			assert.match(content[0]?.text ?? "", /Message not sent: 400 Bad Request: chat not found/);
		} finally {
			await rig.close();
		}
	});

	it("answers list_chats with the chats the poller has seen", async () => {
		const chats: SeenChat[] = [
			{ id: "-1001234", title: "Team chat", type: "supergroup" },
			{ id: "4711", title: "Ilya", type: "private" },
		];
		const rig = await connect({ chats });
		try {
			const result = await rig.client.callTool({ name: "list_chats", arguments: {} });
			const content = result.content as { type: string; text?: string }[];
			assert.deepEqual(JSON.parse(content[0]?.text ?? ""), chats);
			assert.deepEqual(rig.calls, []);
		} finally {
			await rig.close();
		}
	});
});
