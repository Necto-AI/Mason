/**
 * The browser's side of pairing: the credential is a cookie the page cannot read, so all the client does is ask who it
 * is and open a socket the browser authenticates by itself.
 *
 * Pure functions on purpose — no DOM at import time, so the client stays thin and testable in node.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeSession, socketUrl } from "../src/web/lib/session.ts";

function answer(status: number, body: unknown): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

const requested: string[] = [];
function recording(status: number, body: unknown): typeof fetch {
	return (async (input: string) => {
		requested.push(String(input));
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
}

describe("the browser session", () => {
	it("opens the socket with nothing but the page's own origin", () => {
		// No `?token=`: the browser attaches the cookie to the handshake, so the URL stays a URL and never a credential.
		assert.equal(socketUrl({ protocol: "http:", host: "127.0.0.1:8787" }), "ws://127.0.0.1:8787/");
		assert.equal(socketUrl({ protocol: "https:", host: "box.lan" }), "wss://box.lan/");
	});

	it("reads the device the server says this browser is", async () => {
		const session = await probeSession(recording(200, { device: { id: "tok_1234", label: "browser" } }), "");
		assert.deepEqual(session, { id: "tok_1234", label: "browser" });
		assert.deepEqual(requested, ["/api/session"]);
	});

	it("treats a 401 as not paired rather than as a failure", async () => {
		assert.equal(await probeSession(answer(401, { error: "unauthorized" })), undefined);
	});

	it("refuses to guess when the server answers something that is not a device", async () => {
		assert.equal(await probeSession(answer(200, { device: { id: 7 } })), undefined);
		assert.equal(await probeSession(answer(200, {})), undefined);
	});

	it("reports a server that is broken rather than pretending it is unpaired", async () => {
		await assert.rejects(() => probeSession(answer(500, { error: "boom" })));
		await assert.rejects(async () => {
			await probeSession((async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch);
		});
	});
});
