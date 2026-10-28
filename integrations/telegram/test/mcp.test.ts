/**
 * The tools face over the real protocol, with no socket in it.
 *
 * A client and a server joined by the SDK's in-memory transport: `tools/list` is answered by the same code mason's
 * `McpClient` talks to over HTTP, and `tools/call` reaches a fake send instead of Telegram. That is the closest a test
 * gets to what mason will do at boot without binding a port, and it is enough to pin the two things that can be wrong
 * here — the surface being bigger than three tools, and an argument not reaching the call that uses it.
 *
 * `send_file` is also the one tool with a filesystem behind it, so its rig is a real temporary inbox: the refusals this
 * test cares about (outside the inbox, a `..`, a symlink, a directory, a missing file, a size, a caption) are decisions
 * about real paths, and a fake resolver would pin a copy of the rule instead of the rule.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, it } from "node:test";
import { createMcpServer, type TelegramTools } from "../src/mcp.ts";
import type { SeenChat } from "../src/state.ts";
import type { SendFileOptions, SendOutcome, UploadKind } from "../src/telegram.ts";

interface Call {
	readonly chatId: string;
	readonly text: string;
	readonly replyToMessageId: number | undefined;
}

interface FileCall {
	readonly chatId: string;
	readonly name: string;
	readonly kind: UploadKind;
	readonly caption: string | undefined;
	readonly bytes: Uint8Array;
}

interface Rig {
	readonly client: Client;
	readonly calls: Call[];
	readonly fileCalls: FileCall[];
	readonly chats: SeenChat[];
	/** The chats the typing indicator was told about, in order. */
	readonly stops: string[];
	/** The inbox: a temporary directory, and the only place this rig's `send_file` may read from. */
	readonly inbox: string;
	/** A directory beside it, for the files that must not be sent. */
	readonly outside: string;
	close(): Promise<void>;
}

interface RigOptions {
	readonly outcome?: SendOutcome;
	readonly fileOutcome?: SendOutcome;
	readonly chats?: SeenChat[];
}

async function connect(options: RigOptions = {}): Promise<Rig> {
	const calls: Call[] = [];
	const fileCalls: FileCall[] = [];
	const stops: string[] = [];
	const chats = options.chats ?? [];
	const root = await mkdtemp(join(tmpdir(), "mason-telegram-mcp-"));
	const inbox = join(root, "inbox");
	const outside = join(root, "outside");
	await mkdir(inbox, { recursive: true });
	await mkdir(outside, { recursive: true });
	const tools: TelegramTools = {
		send: async (request) => {
			calls.push({ chatId: request.chatId, text: request.text, replyToMessageId: request.replyToMessageId });
			return options.outcome ?? { kind: "sent", messageId: 4_242 };
		},
		sendFile: async (request: SendFileOptions) => {
			fileCalls.push({
				chatId: request.chatId,
				name: request.name,
				kind: request.kind,
				caption: request.caption,
				bytes: request.bytes,
			});
			return options.fileOutcome ?? { kind: "sent", messageId: 4_243 };
		},
		inboxDir: inbox,
		chats: () => chats,
		typing: {
			stop: (chatId) => {
				stops.push(chatId);
			},
		},
	};
	const server = createMcpServer(tools);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "mason", version: "0.1.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return {
		client,
		calls,
		fileCalls,
		chats,
		stops,
		inbox,
		outside,
		close: async () => {
			await client.close();
			await server.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** The text of a tool result, which is the only content any of these tools answers with. */
function textOf(result: unknown): string {
	const content = (result as { content?: { type: string; text?: string }[] }).content;
	return content?.[0]?.text ?? "";
}

/**
 * A file of `bytes` with nothing written in it. A cap is a number in bytes, and proving the refusal by allocating 50 MiB
 * of zeroes would cost 50 MiB and prove the same thing.
 */
async function sparse(path: string, bytes: number): Promise<void> {
	const handle = await open(path, "w");
	try {
		await handle.truncate(bytes);
	} finally {
		await handle.close();
	}
}

describe("the tools face", () => {
	it("offers exactly send_message, send_file and list_chats, and nothing else", async () => {
		const rig = await connect();
		try {
			const { tools } = await rig.client.listTools();
			assert.deepEqual(
				tools.map((tool) => tool.name).sort(),
				["list_chats", "send_file", "send_message"],
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

	it("describes send_file's arguments, and says the path is the inbox's", async () => {
		const rig = await connect();
		try {
			const { tools } = await rig.client.listTools();
			const send = tools.find((tool) => tool.name === "send_file");
			const schema = send?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
			assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["caption", "chat_id", "path"]);
			assert.deepEqual(schema.required, ["chat_id", "path"]);
			// A photo renders and a document downloads: the model has to know which name buys which before it picks one.
			assert.match(send?.description ?? "", /renders in the chat/);
			assert.match(send?.description ?? "", /arrives as a download/);
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
			assert.deepEqual(JSON.parse(textOf(result)), { chat_id: "-1001234", message_id: 4_242 });
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
			assert.match(textOf(result), /Message not sent: 400 Bad Request: chat not found/);
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
			assert.deepEqual(JSON.parse(textOf(result)), chats);
			assert.deepEqual(rig.calls, []);
		} finally {
			await rig.close();
		}
	});
});

describe("send_file", () => {
	it("sends the bytes of a file in the inbox, under its own name, and returns the message id", async () => {
		const rig = await connect();
		try {
			const path = join(rig.inbox, "notes.txt");
			await writeFile(path, "hello from the inbox");

			const result = await rig.client.callTool({
				name: "send_file",
				arguments: { chat_id: "-1001234", path, caption: "the notes" },
			});

			assert.equal(result.isError, undefined);
			assert.deepEqual(
				rig.fileCalls.map(({ bytes, ...rest }) => ({ ...rest, bytes: Buffer.from(bytes).toString() })),
				[
					{
						chatId: "-1001234",
						name: "notes.txt",
						kind: "document",
						caption: "the notes",
						bytes: "hello from the inbox",
					},
				],
			);
			assert.deepEqual(JSON.parse(textOf(result)), { chat_id: "-1001234", message_id: 4_243 });
			// The answer arrived, so the dots are replaced by it, exactly as `send_message` does it.
			assert.deepEqual(rig.stops, ["-1001234"]);
		} finally {
			await rig.close();
		}
	});

	it("sends a photo extension inline and everything else as a document", async () => {
		const rig = await connect();
		try {
			const photo = join(rig.inbox, "shot.png");
			const document = join(rig.inbox, "report.pdf");
			await writeFile(photo, "png bytes");
			await writeFile(document, "pdf bytes");

			await rig.client.callTool({ name: "send_file", arguments: { chat_id: "4711", path: photo } });
			await rig.client.callTool({ name: "send_file", arguments: { chat_id: "4711", path: document } });

			assert.deepEqual(
				rig.fileCalls.map((call) => `${call.kind}:${call.name}`),
				["photo:shot.png", "document:report.pdf"],
			);
		} finally {
			await rig.close();
		}
	});

	it("refuses a file outside the inbox, and says to write it into the inbox first", async () => {
		const rig = await connect();
		try {
			const path = join(rig.outside, "report.pdf");
			await writeFile(path, "not for a chat");

			const result = await rig.client.callTool({ name: "send_file", arguments: { chat_id: "4711", path } });

			assert.equal(result.isError, true);
			assert.match(textOf(result), /^File not sent: /);
			assert.match(textOf(result), /outside the inbox/);
			assert.match(textOf(result), /write the file into the inbox first/);
			assert.deepEqual(rig.fileCalls, []);
		} finally {
			await rig.close();
		}
	});

	it("refuses `..` out of the inbox, and allows one that resolves back into it", async () => {
		const rig = await connect();
		try {
			const outside = join(rig.outside, "report.pdf");
			await writeFile(outside, "not for a chat");
			const escaped = join(rig.inbox, "..", "outside", "report.pdf");

			const refused = await rig.client.callTool({
				name: "send_file",
				arguments: { chat_id: "4711", path: escaped },
			});
			assert.equal(refused.isError, true);
			assert.match(textOf(refused), /outside the inbox/);

			// The check is on the resolved path, not on the string: this one climbs out and lands back inside.
			const inside = join(rig.inbox, "notes.txt");
			await writeFile(inside, "hello");
			const allowed = await rig.client.callTool({
				name: "send_file",
				arguments: { chat_id: "4711", path: join(rig.inbox, "..", "inbox", "notes.txt") },
			});
			assert.equal(allowed.isError, undefined);
			assert.equal(rig.fileCalls.length, 1);
		} finally {
			await rig.close();
		}
	});

	it("refuses a sibling directory whose name begins with the inbox's, because a separator is what makes it one", async () => {
		const rig = await connect();
		try {
			const sibling = `${rig.inbox}-evil`;
			await mkdir(sibling, { recursive: true });
			const path = join(sibling, "report.pdf");
			await writeFile(path, "not for a chat");

			const result = await rig.client.callTool({ name: "send_file", arguments: { chat_id: "4711", path } });

			assert.equal(result.isError, true);
			assert.match(textOf(result), /outside the inbox/);
			assert.deepEqual(rig.fileCalls, []);
		} finally {
			await rig.close();
		}
	});

	it("refuses a symlink that escapes the inbox", async () => {
		const rig = await connect();
		try {
			const target = join(rig.outside, "secret.pdf");
			await writeFile(target, "not for a chat");
			const link = join(rig.inbox, "looks-inside.pdf");
			await symlink(target, link);

			const result = await rig.client.callTool({ name: "send_file", arguments: { chat_id: "4711", path: link } });

			assert.equal(result.isError, true);
			assert.match(textOf(result), /outside the inbox/);
			assert.deepEqual(rig.fileCalls, []);
		} finally {
			await rig.close();
		}
	});

	it("refuses a directory and a file that is not there", async () => {
		const rig = await connect();
		try {
			const directory = join(rig.inbox, "a-directory");
			await mkdir(directory);

			const refusedDirectory = await rig.client.callTool({
				name: "send_file",
				arguments: { chat_id: "4711", path: directory },
			});
			assert.equal(refusedDirectory.isError, true);
			assert.match(textOf(refusedDirectory), /is a directory, and only a file can be sent/);

			const missing = join(rig.inbox, "gone.pdf");
			const refusedMissing = await rig.client.callTool({
				name: "send_file",
				arguments: { chat_id: "4711", path: missing },
			});
			assert.equal(refusedMissing.isError, true);
			assert.match(textOf(refusedMissing), /there is no file at/);
			assert.deepEqual(rig.fileCalls, []);
		} finally {
			await rig.close();
		}
	});

	it("refuses a file over Telegram's cap, naming the number instead of cutting it", async () => {
		const rig = await connect();
		try {
			const photo = join(rig.inbox, "huge.png");
			await sparse(photo, 10 * 1024 * 1024 + 1);
			const document = join(rig.inbox, "huge.pdf");
			await sparse(document, 50 * 1024 * 1024 + 1);

			const refusedPhoto = await rig.client.callTool({
				name: "send_file",
				arguments: { chat_id: "4711", path: photo },
			});
			assert.equal(refusedPhoto.isError, true);
			assert.match(textOf(refusedPhoto), /10\.01 MiB/);
			assert.match(textOf(refusedPhoto), /at most 10 MiB as a photo/);

			const refusedDocument = await rig.client.callTool({
				name: "send_file",
				arguments: { chat_id: "4711", path: document },
			});
			assert.equal(refusedDocument.isError, true);
			assert.match(textOf(refusedDocument), /50\.01 MiB/);
			assert.match(textOf(refusedDocument), /at most 50 MiB as a document/);
			assert.deepEqual(rig.fileCalls, []);
		} finally {
			await rig.close();
		}
	});

	it("refuses a caption over 1024 characters, naming the numbers", async () => {
		const rig = await connect();
		try {
			const path = join(rig.inbox, "notes.txt");
			await writeFile(path, "hello");

			const result = await rig.client.callTool({
				name: "send_file",
				arguments: { chat_id: "4711", path, caption: "x".repeat(1_025) },
			});

			assert.equal(result.isError, true);
			assert.match(textOf(result), /1025 characters/);
			assert.match(textOf(result), /at most 1024/);
			assert.deepEqual(rig.fileCalls, []);
		} finally {
			await rig.close();
		}
	});

	it("reports a refused send as a tool error with the reason", async () => {
		const rig = await connect({ fileOutcome: { kind: "failed", error: "400 Bad Request: file is too big" } });
		try {
			const path = join(rig.inbox, "notes.txt");
			await writeFile(path, "hello");

			const result = await rig.client.callTool({ name: "send_file", arguments: { chat_id: "4711", path } });

			assert.equal(result.isError, true);
			assert.match(textOf(result), /File not sent: 400 Bad Request: file is too big/);
		} finally {
			await rig.close();
		}
	});
});
