/**
 * The Telegram call itself: what goes on the wire, and what each answer becomes.
 *
 * The mapping is pinned here rather than at the tool boundary, because the two questions are different: the tool test
 * proves a model's arguments reach `send`, and this one proves `send` asks Telegram for the right thing — including the
 * one field that is not obvious, the reply, which Telegram spells `reply_parameters`.
 *
 * The two file calls are here for the same reason, and one of them is a URL of its own: `getFile` answers a path, and the
 * download is a GET on `/file/bot<token>/<path>` rather than on `/bot<token>/<method>` — a shape only this file knows,
 * and one a failure must describe without printing the token in it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TelegramApi, TelegramError, type Fetch, type FetchRequest, type FetchResponse } from "../src/telegram.ts";

const TOKEN = "123456789:AAF-abcdefghijklmnopqrstuvwxyz012345";

interface Sent {
	readonly url: string;
	readonly request: FetchRequest;
}

function api(status: number, body: unknown, bytes?: Uint8Array): { api: TelegramApi; sent: Sent[] } {
	const sent: Sent[] = [];
	const fetch: Fetch = async (url, request) => {
		sent.push({ url, request });
		const text = typeof body === "string" ? body : JSON.stringify(body);
		const answer: FetchResponse = {
			ok: status >= 200 && status < 300,
			status,
			statusText: "",
			text: async () => text,
			// A download is the one answer read as bytes; every other call parses this same body as JSON.
			arrayBuffer: async () => (bytes ?? new TextEncoder().encode(text)).buffer as ArrayBuffer,
		};
		return answer;
	};
	return { api: new TelegramApi({ token: TOKEN, fetch }), sent };
}

describe("sendMessage", () => {
	it("posts the chat, the text and the reply to the bot's own URL, and returns the message id", async () => {
		const { api: client, sent } = api(200, { ok: true, result: { message_id: 4_242 } });

		const outcome = await client.sendMessage({ chatId: "-1001234", text: "on it", replyToMessageId: 77 });

		assert.deepEqual(outcome, { kind: "sent", messageId: 4_242 });
		assert.equal(sent[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
		assert.deepEqual(JSON.parse(sent[0]?.request.body ?? ""), {
			chat_id: "-1001234",
			text: "on it",
			reply_parameters: { message_id: 77, allow_sending_without_reply: true },
		});
	});

	it("sends no reply field when the message answers nothing", async () => {
		const { api: client, sent } = api(200, { ok: true, result: { message_id: 1 } });

		await client.sendMessage({ chatId: "4711", text: "hello" });

		assert.deepEqual(Object.keys(JSON.parse(sent[0]?.request.body ?? "") as object), ["chat_id", "text"]);
	});

	it("turns a 429 into the retry_after Telegram asked for, for the queue to honour", async () => {
		const { api: client } = api(429, {
			ok: false,
			error_code: 429,
			description: "Too Many Requests: retry after 12",
			parameters: { retry_after: 12 },
		});

		assert.deepEqual(await client.sendMessage({ chatId: "4711", text: "hi" }), { kind: "throttled", retryAfter: 12 });
	});

	it("turns any other refusal into the description a person can act on", async () => {
		const { api: client } = api(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });

		assert.deepEqual(await client.sendMessage({ chatId: "4711", text: "hi" }), {
			kind: "failed",
			error: "400 Bad Request: chat not found",
		});
	});

	it("reports a network failure as an outcome rather than throwing at a tool call", async () => {
		const fetch: Fetch = async () => {
			throw new Error("connect ECONNREFUSED");
		};
		const client = new TelegramApi({ token: TOKEN, fetch });

		assert.deepEqual(await client.sendMessage({ chatId: "4711", text: "hi" }), {
			kind: "failed",
			error: "request failed: connect ECONNREFUSED",
		});
	});
});

describe("sendChatAction", () => {
	it("asks for typing in the chat, and sends nothing else", async () => {
		const { api: client, sent } = api(200, { ok: true, result: true });

		await client.sendChatAction({ chatId: "-1001234" });

		assert.equal(sent[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendChatAction`);
		assert.deepEqual(JSON.parse(sent[0]?.request.body ?? ""), { chat_id: "-1001234", action: "typing" });
	});

	it("throws when Telegram refuses, so the heartbeat can count it and move on", async () => {
		const { api: client } = api(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });

		await assert.rejects(() => client.sendChatAction({ chatId: "-1001234" }), /chat not found/);
	});
});

describe("getUpdates", () => {
	it("asks for messages only, for the given offset, and holds the request open as long as it was told", async () => {
		const { api: client, sent } = api(200, { ok: true, result: [] });

		await client.getUpdates({ offset: 9, timeout: 30 });

		assert.equal(sent[0]?.url, `https://api.telegram.org/bot${TOKEN}/getUpdates`);
		assert.deepEqual(JSON.parse(sent[0]?.request.body ?? ""), { offset: 9, timeout: 30, allowed_updates: ["message"] });
	});

	it("omits the offset when there is none, which is what a first boot asks for", async () => {
		const { api: client, sent } = api(200, { ok: true, result: [] });

		await client.getUpdates({ timeout: 0 });

		assert.deepEqual(JSON.parse(sent[0]?.request.body ?? ""), { timeout: 0, allowed_updates: ["message"] });
	});

	it("raises the retry_after Telegram sends with a 429 on the poll", async () => {
		const { api: client } = api(429, {
			ok: false,
			error_code: 429,
			description: "Too Many Requests",
			parameters: { retry_after: 30 },
		});

		await assert.rejects(
			() => client.getUpdates({ timeout: 30 }),
			(error: unknown) => error instanceof TelegramError && error.retryAfter === 30,
		);
	});
});

describe("getMe", () => {
	it("answers with the username the mention stripper needs", async () => {
		const { api: client } = api(200, { ok: true, result: { id: 42, first_name: "Mason", username: "mason_bot" } });

		assert.deepEqual(await client.getMe(), { id: 42, username: "mason_bot" });
	});
});

describe("getFile", () => {
	it("asks for the file id at the bot's own method URL, and answers with the path and the size", async () => {
		const { api: client, sent } = api(200, {
			ok: true,
			result: { file_id: "f1", file_unique_id: "u1", file_path: "documents/report.pdf", file_size: 1_234 },
		});

		assert.deepEqual(await client.getFile({ fileId: "f1" }), {
			filePath: "documents/report.pdf",
			fileSize: 1_234,
		});
		assert.equal(sent[0]?.url, `https://api.telegram.org/bot${TOKEN}/getFile`);
		assert.deepEqual(JSON.parse(sent[0]?.request.body ?? ""), { file_id: "f1" });
	});

	it("answers without a size when Telegram sent none, which a voice note never does", async () => {
		const { api: client } = api(200, { ok: true, result: { file_path: "voice/file_1.oga" } });

		assert.deepEqual(await client.getFile({ fileId: "f1" }), { filePath: "voice/file_1.oga" });
	});

	it("refuses an answer that names no path to download", async () => {
		const { api: client } = api(200, { ok: true, result: { file_id: "f1" } });

		await assert.rejects(() => client.getFile({ fileId: "f1" }), /carried no file_path/);
	});
});

describe("downloadFile", () => {
	it("gets the bytes from the file route, which is not the method route every other call uses", async () => {
		const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
		const { api: client, sent } = api(200, "", bytes);

		assert.deepEqual(await client.downloadFile({ filePath: "documents/report.pdf" }), bytes);
		assert.equal(sent[0]?.url, `https://api.telegram.org/file/bot${TOKEN}/documents/report.pdf`);
		assert.equal(sent[0]?.request.method, "GET");
	});

	it("turns a 404 into a TelegramError that names the status and never the token", async () => {
		const { api: client } = api(404, "Not Found");

		await assert.rejects(
			() => client.downloadFile({ filePath: "documents/gone.pdf" }),
			(error: unknown) => {
				assert.ok(error instanceof TelegramError);
				assert.equal(error.name, "TelegramError");
				// The URL this failed on holds the token, so the message is built from the status and nothing else.
				assert.equal(error.message.startsWith("Telegram downloadFile failed (404)"), true);
				assert.equal(error.message.includes(TOKEN), false, error.message);
				return true;
			},
		);
	});
});
