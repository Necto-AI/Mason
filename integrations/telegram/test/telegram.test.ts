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

/** The form an upload carried. Every other call sends JSON, and `jsonBody` reads that. */
function formOf(request: FetchRequest | undefined): FormData {
	const body = request?.body;
	if (!(body instanceof FormData)) assert.fail("this call was expected to carry a FormData body");
	return body;
}

/** One file part of an upload, by the field Telegram names it under. */
async function partOf(form: FormData, field: string): Promise<File> {
	const value = form.get(field);
	if (!(value instanceof File)) assert.fail(`the form carried no file part called ${field}`);
	return value;
}

/**
 * The JSON one call carried. Every call but an upload sends a string body, and an upload's `FormData` is read as a form in
 * its own tests below; this helper is what keeps the JSON assertions about fields rather than about a union.
 */
function jsonBody(request: FetchRequest | undefined): unknown {
	const body = request?.body;
	if (typeof body !== "string") assert.fail("this call was expected to carry a JSON body");
	return JSON.parse(body);
}

describe("sendMessage", () => {
	it("posts the chat, the text and the reply to the bot's own URL, and returns the message id", async () => {
		const { api: client, sent } = api(200, { ok: true, result: { message_id: 4_242 } });

		const outcome = await client.sendMessage({ chatId: "-1001234", text: "on it", replyToMessageId: 77 });

		assert.deepEqual(outcome, { kind: "sent", messageId: 4_242 });
		assert.equal(sent[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
		assert.deepEqual(jsonBody(sent[0]?.request), {
			chat_id: "-1001234",
			text: "on it",
			reply_parameters: { message_id: 77, allow_sending_without_reply: true },
		});
	});

	it("sends no reply field when the message answers nothing", async () => {
		const { api: client, sent } = api(200, { ok: true, result: { message_id: 1 } });

		await client.sendMessage({ chatId: "4711", text: "hello" });

		assert.deepEqual(Object.keys(jsonBody(sent[0]?.request) as object), ["chat_id", "text"]);
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

describe("sendFile", () => {
	const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

	it("posts a document as multipart to sendDocument, with the chat, the caption and the file's own name", async () => {
		const { api: client, sent } = api(200, { ok: true, result: { message_id: 4_243 } });

		const outcome = await client.sendFile({
			chatId: "-1001234",
			bytes,
			name: "report.pdf",
			kind: "document",
			caption: "the report",
		});

		assert.deepEqual(outcome, { kind: "sent", messageId: 4_243 });
		assert.equal(sent[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendDocument`);
		const form = formOf(sent[0]?.request);
		assert.equal(form.get("chat_id"), "-1001234");
		assert.equal(form.get("caption"), "the report");
		const part = await partOf(form, "document");
		assert.equal(part.name, "report.pdf");
		assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes);
	});

	it("leaves the boundary to the HTTP client, and names no content type of its own", async () => {
		const { api: client, sent } = api(200, { ok: true, result: { message_id: 1 } });

		await client.sendFile({ chatId: "4711", bytes, name: "note.txt", kind: "document" });

		// A hand-set content type is a header that disagrees with the body: the client writes the boundary, and only it
		// knows the boundary.
		assert.equal(sent[0]?.request.headers["content-type"], undefined);
		assert.ok(sent[0]?.request.body instanceof FormData);
	});

	it("leaves the caption out when there is none, rather than sending an empty one", async () => {
		const { api: client, sent } = api(200, { ok: true, result: { message_id: 1 } });

		await client.sendFile({ chatId: "4711", bytes, name: "note.txt", kind: "document" });

		assert.equal(formOf(sent[0]?.request).has("caption"), false);
	});

	it("posts a photo to sendPhoto, under the photo part", async () => {
		const { api: client, sent } = api(200, { ok: true, result: { message_id: 2 } });

		const outcome = await client.sendFile({ chatId: "4711", bytes, name: "photo.png", kind: "photo" });

		assert.deepEqual(outcome, { kind: "sent", messageId: 2 });
		assert.equal(sent[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendPhoto`);
		assert.equal((await partOf(formOf(sent[0]?.request), "photo")).name, "photo.png");
	});

	it("turns a 429 into the retry_after Telegram asked for, exactly as a message does", async () => {
		const { api: client } = api(429, {
			ok: false,
			error_code: 429,
			description: "Too Many Requests: retry after 12",
			parameters: { retry_after: 12 },
		});

		assert.deepEqual(await client.sendFile({ chatId: "4711", bytes, name: "a.pdf", kind: "document" }), {
			kind: "throttled",
			retryAfter: 12,
		});
	});

	it("turns a 400 into the description, and names neither the URL nor the token", async () => {
		const { api: client } = api(400, { ok: false, error_code: 400, description: "Bad Request: file is too big" });

		const outcome = await client.sendFile({ chatId: "4711", bytes, name: "a.pdf", kind: "document" });

		assert.deepEqual(outcome, { kind: "failed", error: "400 Bad Request: file is too big" });
		const error = outcome.kind === "failed" ? outcome.error : "";
		assert.equal(error.includes("api.telegram.org"), false, error);
		assert.equal(error.includes(TOKEN), false, error);
	});

	it("takes the token out of a request failure before it becomes a tool result", async () => {
		const client = new TelegramApi({
			token: TOKEN,
			fetch: async () => {
				throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendDocument`);
			},
		});

		const outcome = await client.sendFile({ chatId: "4711", bytes, name: "a.pdf", kind: "document" });

		assert.equal(outcome.kind, "failed");
		const error = outcome.kind === "failed" ? outcome.error : "";
		assert.match(error, /request failed: connect ECONNREFUSED/);
		assert.match(error, /\/bot<redacted>\/sendDocument/);
		assert.doesNotMatch(error, new RegExp(TOKEN));
	});
});

describe("sendChatAction", () => {
	it("asks for typing in the chat, and sends nothing else", async () => {
		const { api: client, sent } = api(200, { ok: true, result: true });

		await client.sendChatAction({ chatId: "-1001234" });

		assert.equal(sent[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendChatAction`);
		assert.deepEqual(jsonBody(sent[0]?.request), { chat_id: "-1001234", action: "typing" });
	});

	it("throws when Telegram refuses, so the heartbeat can count it and move on", async () => {
		const { api: client } = api(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });

		await assert.rejects(() => client.sendChatAction({ chatId: "-1001234" }), /chat not found/);
	});
});

describe("getFile and the download", () => {
	it("throws a request failure that names no token when the fetch itself rejects", async () => {
		const client = new TelegramApi({
			token: TOKEN,
			fetch: async () => {
				throw new Error(`connect ECONNREFUSED https://api.telegram.org/file/bot${TOKEN}/documents/x`);
			},
		});

		await assert.rejects(
			() => client.downloadFile({ filePath: "documents/x" }),
			(error: unknown) => error instanceof TelegramError && /request failed:/.test(error.message) && !error.message.includes(TOKEN),
		);
	});
});

describe("getUpdates", () => {
	it("asks for messages only, for the given offset, and holds the request open as long as it was told", async () => {
		const { api: client, sent } = api(200, { ok: true, result: [] });

		await client.getUpdates({ offset: 9, timeout: 30 });

		assert.equal(sent[0]?.url, `https://api.telegram.org/bot${TOKEN}/getUpdates`);
		assert.deepEqual(jsonBody(sent[0]?.request), { offset: 9, timeout: 30, allowed_updates: ["message"] });
	});

	it("omits the offset when there is none, which is what a first boot asks for", async () => {
		const { api: client, sent } = api(200, { ok: true, result: [] });

		await client.getUpdates({ timeout: 0 });

		assert.deepEqual(jsonBody(sent[0]?.request), { timeout: 0, allowed_updates: ["message"] });
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
		assert.deepEqual(jsonBody(sent[0]?.request), { file_id: "f1" });
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
