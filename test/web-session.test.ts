/**
 * The browser's side of pairing: the credential is a cookie the page cannot read, so all the client does is ask who it
 * is, pick a name off the roster when it has none, and open a socket the browser authenticates by itself.
 *
 * Pure functions on purpose — no DOM at import time, so the client stays thin and testable in node.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimPerson, probeSession, screenFor, socketUrl } from "../src/web/lib/session.ts";

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

interface Sent {
	readonly url: string;
	readonly method: string | undefined;
	readonly body: string | undefined;
}

function accepting(status: number, body: unknown, sent: Sent[]): typeof fetch {
	return (async (input: string, init?: RequestInit) => {
		sent.push({
			url: String(input),
			method: init?.method,
			body: typeof init?.body === "string" ? init.body : undefined,
		});
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
		assert.deepEqual(session, { device: { id: "tok_1234", label: "browser" } });
		assert.deepEqual(requested, ["/api/session"]);
	});

	it("reads the person a browser has already claimed", async () => {
		const session = await probeSession(
			answer(200, { device: { id: "tok_1234", label: "browser" }, person: { name: "Ilya" } }),
			"",
		);
		assert.deepEqual(session, {
			device: { id: "tok_1234", label: "browser" },
			person: { name: "Ilya" },
		});
	});

	it("reads the roster the server offers a browser that has not claimed a name", async () => {
		const session = await probeSession(
			answer(200, {
				device: { id: "tok_1234", label: "browser" },
				roster: [{ name: "Denis" }, { name: "Ilya" }, { role: "member" }, "nope"],
			}),
			"",
		);
		// An entry that is not a name is dropped rather than shown as a blank choice: the picker has to be pickable.
		// A field the server does not send (an old `role`) is not read either: the wire carries the name alone.
		assert.deepEqual(session?.roster, [{ name: "Denis" }, { name: "Ilya" }]);
		assert.equal(session?.person, undefined);
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

describe("which screen the boot probe opens", () => {
	const device = { id: "tok_1234", label: "browser" };

	it("closes the door on a browser the server does not know", () => {
		assert.deepEqual(screenFor(undefined), { kind: "unpaired" });
	});

	it("asks a paired browser with no name to pick one", () => {
		assert.deepEqual(screenFor({ device, roster: [{ name: "Ilya" }] }), {
			kind: "join",
			roster: [{ name: "Ilya" }],
		});
		// An empty roster still asks: the picker is where a reader is told to have the deployer add a name.
		assert.deepEqual(screenFor({ device, roster: [] }), { kind: "join", roster: [] });
	});

	it("sends a browser that speaks for someone to the conversation", () => {
		assert.deepEqual(screenFor({ device, person: { name: "Ilya" } }), {
			kind: "conversation",
			person: "Ilya",
		});
	});

	it("opens the conversation on a server that predates the roster", () => {
		// No `roster` key at all: an install from before team identity, where an unnamed device is normal, not a door.
		assert.deepEqual(screenFor({ device }), { kind: "conversation", person: undefined });
	});
});

describe("claiming a name", () => {
	it("claims a name with a POST and reads back the person the server chose", async () => {
		const sent: Sent[] = [];
		const result = await claimPerson("Ilya", accepting(200, { person: { name: "Ilya" } }, sent), "");
		assert.deepEqual(result, { ok: true, person: { name: "Ilya" } });
		assert.deepEqual(sent, [{ url: "/api/join", method: "POST", body: JSON.stringify({ name: "Ilya" }) }]);
	});

	it("reports a refused name as a refusal the picker can show, not as a crash", async () => {
		const sent: Sent[] = [];
		const result = await claimPerson("Nobody", accepting(404, { error: "not on the roster" }, sent), "");
		assert.deepEqual(result, { ok: false, reason: "refused" });
	});

	it("reports a server that does not answer instead of claiming success", async () => {
		const unreachable = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		assert.deepEqual(await claimPerson("Ilya", unreachable, ""), { ok: false, reason: "unreachable" });
	});

	it("does not claim a success the server did not name", async () => {
		// A 200 without a person is not a claim: the reader would reload into a conversation that still has no author.
		assert.deepEqual(await claimPerson("Ilya", answer(200, {}), ""), { ok: false, reason: "refused" });
	});
});
