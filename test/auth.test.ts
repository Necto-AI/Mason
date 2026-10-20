/**
 * The door: one owner, a named credential per device, and every entry point proving it.
 *
 * Two layers to test. The token file itself (mint, verify, revoke, and the modes it is written with), then a real
 * server refusing and accepting requests — the socket and `/api` are where the hole was.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import {
	ensureToken,
	listTokens,
	mintToken,
	presentedToken,
	readConfig,
	revokeToken,
	verifyToken,
} from "../src/server/auth.ts";
import { startServer, type RunningServer } from "../src/server/main.ts";

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
		assert.equal((await stat(home)).mode & 0o777, 0o700);
		assert.equal((await stat(join(home, "config.json"))).mode & 0o777, 0o600);
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
		await writeFile(join(home, "config.json"), `{"tokens":[{"id":"tok_1"}],"future":true}`, "utf8");
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

/** The first frame a server sends a fresh client: chord's `hello`. */
function opens(url: string, headers: Record<string, string> = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, { headers });
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error(`socket ${url} sent nothing`));
		}, 5_000);
		socket.on("message", (data) => {
			clearTimeout(timer);
			socket.terminate();
			resolve(String(data));
		});
		socket.on("close", () => {
			clearTimeout(timer);
			reject(new Error(`socket ${url} was refused`));
		});
		socket.on("error", reject);
	});
}

describe("the server's door", () => {
	async function openServer(): Promise<RunningServer> {
		const directory = await mkdtemp(join(tmpdir(), "pda-auth-server-"));
		directories.add(directory);
		return startServer({
			port: 0,
			hostname: "127.0.0.1",
			storage: "memory",
			dataDir: join(directory, "data"),
			workspaceDir: directory,
			houseHome: join(directory, "house"),
			faux: true,
			onReport: () => {},
		});
	}

	it("refuses /api without a token and serves it with one", async () => {
		const server = await openServer();
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

	it("refuses /api from a foreign origin even with the right token", async () => {
		const server = await openServer();
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

	it("closes the socket unless the client is paired and same-origin", async () => {
		const server = await openServer();
		const base = `ws://127.0.0.1:${server.port}/`;
		try {
			await refused(base);
			await refused(`${base}?token=mason_wrong_token_here`);
			await refused(`${base}?token=${server.pairingToken}`, { origin: "https://evil.example" });
			// The drive-by from the security review: a page on another origin, with no token it could not have.
			await refused(base, { origin: "https://evil.example" });

			assert.match(await opens(`${base}?token=${server.pairingToken}`), /"hello"/);
			assert.match(
				await opens(`${base}?token=${server.pairingToken}`, { origin: `http://127.0.0.1:${server.port}` }),
				/"hello"/,
			);
		} finally {
			await server.close();
		}
	});
});
