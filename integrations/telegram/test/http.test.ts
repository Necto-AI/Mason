/**
 * The tools face over a real socket, on the path mason actually uses.
 *
 * `test/mcp.test.ts` drives the three tools over an in-memory transport, which is a client that has already initialized
 * the server it is talking to. Production is not that: `src/http.ts` builds one `McpServer` and one transport per
 * request and keeps no session, so mason's `tools/list` and `tools/call` arrive on a transport that never saw an
 * `initialize` and carry no `Mcp-Session-Id`. That is the only shape a request takes in production, and it is what this
 * file pins — a bound port, three POSTs, and the answers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MCP_PATH } from "../src/constants.ts";
import { startMcpHttp, type RunningMcpServer } from "../src/http.ts";
import { createLog } from "../src/log.ts";
import type { SeenChat } from "../src/state.ts";
import type { SendOutcome } from "../src/telegram.ts";

const CHATS: SeenChat[] = [{ id: "-1001234", title: "Team chat", type: "supergroup" }];

interface Sent {
	readonly chatId: string;
	readonly text: string;
}

interface Answer {
	readonly id: unknown;
	readonly result: unknown;
	readonly error: unknown;
}

interface HttpRig {
	readonly server: RunningMcpServer;
	readonly sent: Sent[];
	/** One POST, and the JSON-RPC answer in it. Never a `Mcp-Session-Id`, because this face has no sessions. */
	post(message: unknown): Promise<Answer>;
	/** One POST, and the raw response, for the headers a JSON answer does not carry. */
	postRaw(message: unknown): Promise<Response>;
	close(): Promise<void>;
}

async function rig(): Promise<HttpRig> {
	const sent: Sent[] = [];
	const server = await startMcpHttp({
		// Port 0: the kernel picks one, so two test runs never collide and nothing wide is bound.
		port: 0,
		tools: {
			send: async (options): Promise<SendOutcome> => {
				sent.push({ chatId: options.chatId, text: options.text });
				return { kind: "sent", messageId: 4_242 };
			},
			// A file is the other tool this rig does not exercise: the endpoint is what is under test here, and `send_file`
			// has its own tests in `test/mcp.test.ts` and `test/telegram.test.ts`.
			sendFile: async (): Promise<SendOutcome> => ({ kind: "sent", messageId: 4_242 }),
			chats: () => CHATS,
			inboxDir: "/home/mason/.mason/agent/workspace/inbox",
		},
		log: createLog([]),
		host: "127.0.0.1",
	});
	const postRaw = async (message: unknown): Promise<Response> =>
		fetch(`http://127.0.0.1:${server.port}${MCP_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify(message),
		});
	return {
		server,
		sent,
		postRaw,
		post: async (message) => {
			const response = await postRaw(message);
			assert.equal(response.status, 200, `the tools face answered ${response.status}`);
			return asAnswer(await response.json());
		},
		close: () => server.close(),
	};
}

function asAnswer(value: unknown): Answer {
	if (typeof value !== "object" || value === null) {
		throw new Error("the tools face answered with something that is not a JSON object");
	}
	const fields = value as { id?: unknown; result?: unknown; error?: unknown };
	return { id: fields.id, result: fields.result, error: fields.error };
}

function toolsOf(result: unknown): { name: string; description: string | undefined }[] {
	if (typeof result !== "object" || result === null) throw new Error("tools/list answered no result");
	const tools = (result as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) throw new Error("tools/list answered without a tool list");
	return tools as { name: string; description: string | undefined }[];
}

function textOf(result: unknown): string {
	if (typeof result !== "object" || result === null) throw new Error("tools/call answered no result");
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) throw new Error("tools/call answered without content");
	const first = content[0] as { type?: unknown; text?: unknown } | undefined;
	if (first?.type !== "text" || typeof first.text !== "string") throw new Error("tools/call answered no text");
	return first.text;
}

describe("the tools face on a real socket", () => {
	it("answers initialize without a session id, because it keeps no session", async () => {
		const http = await rig();
		try {
			const response = await http.postRaw({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mason", version: "0.1.0" } },
			});

			assert.equal(response.status, 200);
			assert.equal(response.headers.get("mcp-session-id"), null);
			const answer = asAnswer(await response.json());
			assert.equal(answer.id, 1);
			const result = answer.result as { serverInfo?: { name?: unknown } } | null;
			assert.equal(result?.serverInfo?.name, "mason-telegram");
		} finally {
			await http.close();
		}
	});

	it("answers tools/list and tools/call with no session header and no initialize behind them", async () => {
		const http = await rig();
		try {
			const listed = await http.post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
			assert.equal(listed.error, undefined);
			assert.deepEqual(
				toolsOf(listed.result)
					.map((tool) => tool.name)
					.sort(),
				["list_chats", "send_file", "send_message"],
			);

			// The production shape exactly: stateless, no Mcp-Session-Id, on a transport that never saw an initialize.
			const called = await http.post({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "send_message", arguments: { chat_id: "-1001234", text: "on it" } },
			});

			assert.equal(called.error, undefined);
			assert.deepEqual(http.sent, [{ chatId: "-1001234", text: "on it" }]);
			assert.deepEqual(JSON.parse(textOf(called.result)), { chat_id: "-1001234", message_id: 4_242 });
		} finally {
			await http.close();
		}
	});

	it("answers nothing on any other path", async () => {
		const http = await rig();
		try {
			const response = await fetch(`http://127.0.0.1:${http.server.port}/sse`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
			});

			assert.equal(response.status, 404);
			assert.match(await response.text(), new RegExp(`answers ${MCP_PATH} and nothing else`));
		} finally {
			await http.close();
		}
	});
});
