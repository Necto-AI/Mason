/**
 * The door: one owner, a named credential per device, and every entry point proving it.
 *
 * Two layers to test. The token file itself (mint, verify, revoke, and the modes it is written with), then a real
 * server refusing and accepting requests — the socket and `/api` are where the hole was.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import {
	authenticate,
	cookieValue,
	createTokenStore,
	deviceFromCookie,
	ensureToken,
	listTokens,
	mintToken,
	openSession,
	presentedToken,
	readConfig,
	revokeToken,
	sealSession,
	sessionCookieValue,
	verifyToken,
} from "../src/server/auth.ts";
import { type RunningServer, startServer } from "../src/server/main.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporaryHome(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pda-auth-"));
	directories.add(directory);
	return join(directory, "house");
}

describe("tokens", () => {
	it("mints a token, stores only its hash, and verifies it", async () => {
		const home = await temporaryHome();
		const minted = await mintToken(home, "phone");
		assert.match(minted.token, /^mason_[A-Za-z0-9_-]{40,}$/);
		assert.equal(minted.record.label, "phone");

		const stored = JSON.stringify(await readConfig(home));
		assert.ok(!stored.includes(minted.token), "the plaintext token is never written to disk");

		const records = await listTokens(home);
		assert.equal(records.length, 1);
		assert.equal(verifyToken(records, minted.token)?.id, minted.record.id);
		assert.equal(verifyToken(records, "mason_nope"), undefined);
		assert.equal(verifyToken(records, undefined), undefined);
		assert.equal(verifyToken(records, ""), undefined);
	});

	it("writes the home private and the config file private", async () => {
		const home = await temporaryHome();
		const minted = await mintToken(home, "browser");
		assert.ok(minted.token.length > 0);
		// The server's half is the private one: the token hashes are not in the half a tool can see.
		assert.equal((await stat(join(home, "service"))).mode & 0o777, 0o700);
		assert.equal((await stat(join(home, "service", "config.json"))).mode & 0o777, 0o600);
	});

	it("keeps other devices' tokens when one is revoked, and says so when it is not there", async () => {
		const home = await temporaryHome();
		const browser = await mintToken(home, "browser");
		const phone = await mintToken(home, "phone");

		assert.equal(await revokeToken(home, browser.record.id), true);
		const left = await listTokens(home);
		assert.deepEqual(
			left.map((record) => record.label),
			["phone"],
		);
		assert.equal(verifyToken(left, browser.token), undefined, "a revoked token is dead");
		assert.ok(verifyToken(left, phone.token), "the other device still works");
		assert.equal(await revokeToken(home, "tok_missing"), false);
	});

	it("hands out one token on a fresh home, and none on the next start", async () => {
		const home = await temporaryHome();
		const first = await ensureToken(home);
		assert.ok(first.token, "a home without credentials gets one");
		assert.equal(first.records.length, 1);

		const second = await ensureToken(home);
		assert.equal(second.token, undefined, "a restart does not mint a second token");
		assert.deepEqual(
			second.records.map((record) => record.id),
			first.records.map((record) => record.id),
		);
	});

	it("reads a hand-edited config as no tokens rather than crashing", async () => {
		const home = await temporaryHome();
		await ensureToken(home);
		await mkdir(join(home, "service"), { recursive: true });
		await writeFile(join(home, "service", "config.json"), `{"tokens":[{"id":"tok_1"}],"future":true}`, "utf8");
		const config = await readConfig(home);
		assert.deepEqual(config.tokens, [], "a malformed record is dropped, not trusted");
		assert.equal(config.future, true, "unknown keys are kept");

		await mintToken(home, "browser");
		assert.equal((await readConfig(home)).future, true, "and survive a rewrite");
	});

	it("takes the token from a bearer header or a query string, and never from neither", async () => {
		const withHeader = presentedToken({ headers: { authorization: "Bearer mason_abc" }, url: "/" } as never);
		assert.equal(withHeader, "mason_abc");
		const query = presentedToken({ headers: {}, url: "/?token=mason_xyz" } as never);
		assert.equal(query, "mason_xyz");
		assert.equal(presentedToken({ headers: {}, url: "/" } as never), undefined);
		assert.equal(presentedToken({ headers: { authorization: "Bearer " }, url: "/" } as never), undefined);
	});
});

describe("the browser's session", () => {
	it("signs a cookie that names a device and carries no secret", async () => {
		const home = await temporaryHome();
		const minted = await mintToken(home, "browser");
		const key = (await readConfig(home)).sessionKey;
		assert.equal(typeof key, "string");

		const value = sealSession(key as string, minted.record.id);
		assert.ok(value.startsWith("v1.tok_"));
		assert.ok(!value.includes(minted.token), "the token itself is never in the cookie");
		assert.equal(openSession(key as string, value)?.tokenId, minted.record.id);

		// A cookie signed by another home, or with an id the sender chose, is not a session.
		assert.equal(openSession(sealSession("z".repeat(43), minted.record.id), value), undefined);
		assert.equal(openSession(key as string, "v1.tok_other.signature"), undefined);
		assert.equal(openSession(key as string, "nonsense"), undefined);
		assert.equal(openSession(key as string, `v2.${minted.record.id}.x`), undefined);
	});

	it("names a device in the cookie, and reads a v2 cookie from before the cutover as one too", async () => {
		const home = await temporaryHome();
		const minted = await mintToken(home, "browser");
		const key = (await readConfig(home)).sessionKey as string;

		assert.deepEqual(openSession(key, sealSession(key, minted.record.id)), { tokenId: minted.record.id });

		// A cookie signed by a build that kept a room: the person is inside the signed material, so it is read to check the
		// signature and then dropped. Refusing it would log out every browser paired before the cutover for no gain.
		const legacy = `v2.${minted.record.id}.${Buffer.from("Ilya", "utf8").toString("base64url")}`;
		const signature = createHmac("sha256", key).update(`v2:${minted.record.id}:Ilya`, "utf8").digest("base64url");
		const named = `${legacy}.${signature}`;
		assert.deepEqual(openSession(key, named), { tokenId: minted.record.id }, "a v2 cookie names a device, no person");

		// The name is inside the signed material, so swapping it out is a forgery rather than a rename.
		const [version, tokenId, , carried] = named.split(".");
		const forged = [version, tokenId, Buffer.from("Denis", "utf8").toString("base64url"), carried].join(".");
		assert.equal(openSession(key, forged), undefined, "a cookie cannot be decoded into a different person");

		// A cookie another home signed is not a session here, whatever it claims.
		assert.equal(openSession(key, sealSession("z".repeat(43), minted.record.id)), undefined);
		assert.equal(openSession("z".repeat(43), named), undefined);

		// The cookie keeps the attributes that make it unreadable to a page and unusable from another site.
		const cookie = sessionCookieValue(key, minted.record.id, false);
		assert.match(cookie, /HttpOnly/);
		assert.match(cookie, /SameSite=Strict/);
		assert.ok(!cookie.includes(minted.token), "the id names a record; the token is never in the cookie");
	});

	it("reads one cookie out of a header that holds several", () => {
		assert.equal(cookieValue("a=1; mason_session=v1.tok_1.sig; b=2"), "v1.tok_1.sig");
		assert.equal(cookieValue("mason_session="), "");
		assert.equal(cookieValue(undefined), undefined);
		assert.equal(cookieValue("other=1"), undefined);
	});

	it("resolves a cookie to a device, and to nothing once that device is revoked", async () => {
		const home = await temporaryHome();
		const minted = await mintToken(home, "browser");
		const value = sealSession((await readConfig(home)).sessionKey as string, minted.record.id);
		const request = { headers: { cookie: `mason_session=${value}` } } as never;

		assert.equal(deviceFromCookie(request, await readConfig(home))?.label, "browser");
		await revokeToken(home, minted.record.id);
		assert.equal(deviceFromCookie(request, await readConfig(home)), undefined, "revoking a token ends its sessions");
	});

	it("applies a revoke to the next request, without a restart", async () => {
		const home = await temporaryHome();
		const browser = await mintToken(home, "browser");
		const phone = await mintToken(home, "phone");
		const store = createTokenStore(home);
		const bearer = (token: string) =>
			({ headers: { authorization: `Bearer ${token}` }, url: "/api/status" }) as never;

		assert.equal((await authenticate(bearer(browser.token), store)).ok, true);
		assert.equal((await authenticate(bearer(phone.token), store)).ok, true);

		assert.equal(await revokeToken(home, browser.record.id), true);
		assert.equal((await authenticate(bearer(browser.token), store)).ok, false, "the store is not a cache");
		assert.equal((await authenticate(bearer(phone.token), store)).ok, true, "the other device keeps working");
	});

	it("refuses a foreign origin before it reads any credential", async () => {
		const home = await temporaryHome();
		const minted = await mintToken(home, "browser");
		const store = createTokenStore(home);
		const foreign = {
			headers: {
				authorization: `Bearer ${minted.token}`,
				origin: "https://evil.example",
				host: "127.0.0.1:8787",
			},
			url: "/api/status",
		} as never;
		assert.deepEqual(await authenticate(foreign, store), { ok: false, reason: "origin" });
	});
});

/**
 * A socket the server closes before it can be used.
 *
 * The WebSocket handshake itself succeeds: chord accepts the HTTP upgrade and then closes the link, so the assertion is
 * "not one frame of state arrived", not "the TCP connection bounced".
 */
function refused(url: string, headers: Record<string, string> = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, { headers });
		const frames: string[] = [];
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error(`socket ${url} neither sent a frame nor closed`));
		}, 5_000);
		socket.on("message", (data) => frames.push(String(data)));
		socket.on("close", () => {
			clearTimeout(timer);
			// Chord says goodbye with a reason (`{"t":"bye","reason":"unauthorized"}`): a refusal is a close, not
			// silence, and anything that is not that goodbye means state was handed out.
			const leaked = frames.filter((frame) => !frame.includes('"bye"'));
			if (leaked.length > 0) reject(new Error(`socket ${url} was accepted: ${leaked[0]?.slice(0, 80)}`));
			else resolve();
		});
		socket.on("error", () => {
			// `ws` reports a refused handshake as an error; the close follows it.
		});
	});
}

describe("the server's door", () => {
	async function openServer(): Promise<{ server: RunningServer; home: string }> {
		const directory = await mkdtemp(join(tmpdir(), "pda-auth-server-"));
		directories.add(directory);
		const home = join(directory, "house");
		const server = await startServer({
			port: 0,
			hostname: "127.0.0.1",
			storage: "memory",
			dataDir: join(directory, "data"),
			workspaceDir: directory,
			houseHome: home,
			faux: true,
			onReport: () => {},
		});
		return { server, home };
	}

	it("refuses /api without a token and serves it with one", async () => {
		const { server } = await openServer();
		try {
			const anonymous = await fetch(`http://127.0.0.1:${server.port}/api/status`);
			assert.equal(anonymous.status, 401);
			assert.equal(anonymous.headers.get("www-authenticate"), 'Bearer realm="mason"');

			const wrong = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
				headers: { authorization: "Bearer mason_not_a_token_at_all" },
			});
			assert.equal(wrong.status, 401);

			const paired = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
				headers: { authorization: `Bearer ${server.pairingToken}` },
			});
			assert.equal(paired.status, 200);
			const status = (await paired.json()) as { runStatus?: string };
			assert.equal(typeof status.runStatus, "string");

			// Liveness stays open: a monitor that needs a credential is a monitor nobody runs.
			const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
			assert.equal(health.status, 200);
		} finally {
			await server.close();
		}
	});

	it("puts the permission routes behind the same gate, and answers a shape a caller can act on", async () => {
		const { server } = await openServer();
		const base = `http://127.0.0.1:${server.port}/api/permissions`;
		try {
			assert.equal((await fetch(base)).status, 401, "the pending questions are the owner's");
			const listed = await fetch(base, { headers: { authorization: `Bearer ${server.pairingToken}` } });
			assert.equal(listed.status, 200);
			assert.deepEqual(await listed.json(), { permissions: [] }, "nothing is waiting on a fresh home");

			const refused = await fetch(base, {
				method: "GET",
				headers: { authorization: "Bearer mason_not_a_token_at_all" },
			});
			assert.equal(refused.status, 401);

			// A POST for an id nobody asked about is the route's `404`, not a `500` and not a silent success.
			const unknown = await fetch(`${base}/perm_nothing`, {
				method: "POST",
				headers: { authorization: `Bearer ${server.pairingToken}`, "content-type": "application/json" },
				body: JSON.stringify({ answer: "allow" }),
			});
			assert.equal(unknown.status, 404);
		} finally {
			await server.close();
		}
	});

	it("refuses /api from a foreign origin even with the right token", async () => {
		const { server } = await openServer();
		try {
			const foreign = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
				headers: { authorization: `Bearer ${server.pairingToken}`, origin: "https://evil.example" },
			});
			assert.equal(foreign.status, 401, "a page that is not ours is not the owner, token or no token");

			const own = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
				headers: { authorization: `Bearer ${server.pairingToken}`, origin: `http://127.0.0.1:${server.port}` },
			});
			assert.equal(own.status, 200);
		} finally {
			await server.close();
		}
	});

	it("opens no socket on any path but the connector's", async () => {
		const { server } = await openServer();
		const base = `ws://127.0.0.1:${server.port}/`;
		try {
			// The console's link is gone with the console (#103). An upgrade anywhere but the connector's own path is
			// closed rather than answered: a door that is not there does not offer a handshake first.
			await refused(`${base}?token=${server.pairingToken}`);
			await refused(base, { origin: "https://evil.example" });
			await refused(`${base}some-other-path`);
		} finally {
			await server.close();
		}
	});

	/** The cookie a pairing link hands out, as a browser would keep it. */
	async function pair(port: number, token: string): Promise<string> {
		const response = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, {
			redirect: "manual",
		});
		assert.equal(response.status, 302, "a pairing link is spent, not rendered");
		const setCookie = response.headers.getSetCookie().join("\n");
		assert.match(setCookie, /^mason_session=v1\.tok_[0-9a-f]+\./m);
		return setCookie;
	}

	it("spends a pairing link into a cookie and redirects the token out of the URL", async () => {
		const { server, home } = await openServer();
		const port = server.port as number;
		try {
			const setCookie = await pair(port, server.pairingToken as string);
			assert.match(setCookie, /HttpOnly/, "a script on this origin must not be able to read it");
			assert.match(setCookie, /SameSite=Strict/, "and a cross-site request must not carry it");
			assert.match(setCookie, /Path=\//);
			assert.match(setCookie, /Max-Age=\d+/);
			assert.doesNotMatch(setCookie, new RegExp(server.pairingToken as string), "the token is not the cookie");

			const redirect = await fetch(`http://127.0.0.1:${port}/?token=${server.pairingToken}`, { redirect: "manual" });
			assert.equal(redirect.headers.get("location"), "/");

			const cookie = (setCookie.split(";")[0] as string).trim();
			const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { cookie } });
			assert.equal(session.status, 200);
			const [record] = await listTokens(home);
			assert.deepEqual(await session.json(), {
				device: { id: record?.id, label: record?.label },
				grants: ["conversation", "admin", "approve"],
			});

			// A link that is not one of ours is not a session: the shell still loads, unpaired.
			const wrong = await fetch(`http://127.0.0.1:${port}/?token=mason_wrong_token_here`, { redirect: "manual" });
			assert.equal(wrong.status, 200);
			assert.equal(wrong.headers.getSetCookie().length, 0);
		} finally {
			await server.close();
		}
	});

	/** The one cookie a `Set-Cookie` answer carries, the way a browser would send it back. */
	function cookieOf(setCookie: string): string {
		return (setCookie.split(";")[0] as string).trim();
	}

	it("opens a v2 cookie from before the cutover as a device, and answers no person with it", async () => {
		const { server, home } = await openServer();
		const port = server.port as number;
		try {
			const key = (await readConfig(home)).sessionKey as string;
			const [record] = await listTokens(home);
			const id = (record as { id: string }).id;
			const person = Buffer.from("Ilya", "utf8").toString("base64url");
			const signature = createHmac("sha256", key).update(`v2:${id}:Ilya`, "utf8").digest("base64url");
			const named = cookieOf(`mason_session=v2.${id}.${person}.${signature}; Path=/`);
			const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { cookie: named } });
			assert.equal(session.status, 200, "a browser paired before the cutover stays paired");
			const body = (await session.json()) as Record<string, unknown>;
			assert.deepEqual(body.device, { id, label: record?.label });
			assert.equal("person" in body, false, "there is no person to answer with");
			assert.equal("joined" in body, false);

			// The join route is gone with the room: a page cannot claim a name, so a stale client cannot invent one.
			const device = cookieOf(await pair(port, server.pairingToken as string));
			assert.equal((await fetch(`http://127.0.0.1:${port}/api/join`, { headers: { cookie: device } })).status, 404);
		} finally {
			await server.close();
		}
	});

	it("serves the shell and its headers to nobody in particular", async () => {
		const { server } = await openServer();
		try {
			const shell = await fetch(`http://127.0.0.1:${server.port}/`);
			assert.equal(shell.status, 200, 'the shell is public: it is the page that says "not paired"');
			assert.equal(shell.headers.get("referrer-policy"), "no-referrer");
			assert.equal(shell.headers.get("x-content-type-options"), "nosniff");
			assert.equal(shell.headers.get("x-frame-options"), "DENY");
			const csp = shell.headers.get("content-security-policy") ?? "";
			assert.match(csp, /frame-ancestors 'none'/);
			assert.match(csp, /default-src 'self'/);
			assert.match(csp, /connect-src 'self' /, "the panel polls this origin and nothing else");

			for (const path of ["/api/health", "/api/status"]) {
				const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
				assert.equal(response.headers.get("x-frame-options"), "DENY", `${path} carries the headers too`);
			}
		} finally {
			await server.close();
		}
	});

	it("ends a paired browser's session when its token is revoked, mid-run", async () => {
		const { server, home } = await openServer();
		try {
			const cookie = ((await pair(server.port, server.pairingToken as string)).split(";")[0] as string).trim();
			assert.equal(
				(await fetch(`http://127.0.0.1:${server.port}/api/session`, { headers: { cookie } })).status,
				200,
			);

			const [record] = await listTokens(home);
			assert.equal(await revokeToken(home, (record as { id: string }).id), true);

			const after = await fetch(`http://127.0.0.1:${server.port}/api/session`, { headers: { cookie } });
			assert.equal(after.status, 401, "no restart, no grace period");
			const bearer = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
				headers: { authorization: `Bearer ${server.pairingToken}` },
			});
			assert.equal(bearer.status, 401, "the token that was just revoked is dead too");
		} finally {
			await server.close();
		}
	});
});
