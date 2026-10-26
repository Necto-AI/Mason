/**
 * The two routes out, and the one part of a request they do not share: the class of an upload's `FormData`.
 *
 * A real server on the loopback is the smallest thing that says a body reached the wire as `multipart/form-data` with the
 * fields and the file name in it, rather than as the string `[object FormData]`. That distinction is not academic: the
 * platform's `fetch` brand-checks its own `FormData`, `undici`'s brand-checks its own, and the proxy route goes through
 * `undici`, so `proxiedBody` exists to translate. The test pins both halves of that sentence, including the failure the
 * translation prevents.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { fetch as undiciFetch } from "undici";
import { directFetch, proxiedBody } from "../src/fetch.ts";

interface Received {
	readonly contentType: string | undefined;
	readonly body: string;
}

interface FakeTelegram {
	readonly url: string;
	readonly received: Received[];
	close(): Promise<void>;
}

/** A server that answers every request like Telegram and keeps what arrived. */
async function fakeTelegram(): Promise<FakeTelegram> {
	const received: Received[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			received.push({ contentType: request.headers["content-type"], body });
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		received,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** Exactly what `TelegramApi.sendFile` builds for a document with a caption. */
function upload(): FormData {
	const form = new FormData();
	form.append("chat_id", "-1001234");
	form.append("caption", "the report");
	form.append("document", new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), "report.pdf");
	return form;
}

describe("the direct route", () => {
	it("posts an upload as multipart, with the fields and the file's own name, and sets the boundary itself", async () => {
		const telegram = await fakeTelegram();
		try {
			const answer = await directFetch()(`${telegram.url}/bot123/sendDocument`, {
				method: "POST",
				headers: {},
				body: upload(),
			});

			assert.equal(answer.ok, true);
			const [sent] = telegram.received;
			assert.match(sent?.contentType ?? "", /^multipart\/form-data; boundary=/);
			assert.match(sent?.body ?? "", /name="chat_id"[\s\S]*-1001234/);
			assert.match(sent?.body ?? "", /name="caption"[\s\S]*the report/);
			assert.match(sent?.body ?? "", /name="document"; filename="report.pdf"/);
		} finally {
			await telegram.close();
		}
	});
});

describe("the proxied route", () => {
	it("sends the same form as multipart through undici, and would send the string without the translation", async () => {
		const telegram = await fakeTelegram();
		try {
			// The proxy itself is a pool this test does not need: what is under test is the body `proxiedFetch` hands to
			// the client that has a proxy, and that client is `undiciFetch` in both cases.
			const answer = await undiciFetch(`${telegram.url}/bot123/sendDocument`, {
				method: "POST",
				headers: {},
				body: proxiedBody(upload()),
			});
			assert.equal(answer.status, 200);
			const sent = telegram.received[0];
			assert.match(sent?.contentType ?? "", /^multipart\/form-data; boundary=/);
			assert.match(sent?.body ?? "", /name="document"; filename="report.pdf"/);

			// And the reason `proxiedBody` is not a formality: the untranslated form is not a multipart body at all.
			// `as never` is the point, since neither client's type describes the other's class.
			await undiciFetch(`${telegram.url}/bot123/sendDocument`, {
				method: "POST",
				headers: {},
				body: upload() as never,
			});
			assert.equal(telegram.received[1]?.body, "[object FormData]");
		} finally {
			await telegram.close();
		}
	});
});
