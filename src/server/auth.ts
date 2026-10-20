/**
 * Who may talk to mason.
 *
 * One owner, a few named credentials, and every entry point proving it: the Chord socket, `/api/*`, the webhook. A
 * token is minted once (`npm run token -- add --label phone`), shown once, and stored as a hash in
 * `~/.mason/config.json` (mode 0600) — that file is exactly the kind of thing that ends up pasted into a bug report,
 * so it must not hold a live credential.
 *
 * Two gates, answering different questions:
 *
 * - the **token** says *which device* is calling, so a lost phone is revoked without breaking the browser;
 * - the **Origin** check says *which page* opened the socket. A page on `evil.example` cannot read this origin's
 *   `localStorage`, so it cannot learn the token; the check is the belt to that pair of braces, and it also stops a
 *   page from opening a socket at all. Native app clients send no `Origin` and pass on their token alone.
 *
 * Nothing here is a transport. On a non-loopback address the token crosses the network in clear text until the
 * machine boundary (#20) brings TLS: an SSH tunnel or a TLS proxy is the honest answer before then.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

/** A named credential. The token itself exists only in the hand of whoever minted it. */
export interface TokenRecord {
	readonly id: string;
	/** What this credential is for, e.g. `browser`, `phone`. Shown by `npm run token -- list`. */
	readonly label: string;
	/** SHA-256 of the token, hex. Never the token. */
	readonly sha256: string;
	readonly createdAt: string;
}

/** `~/.mason/config.json`. Unknown keys are preserved: this file grows with the agent. */
export interface MasonConfig {
	readonly tokens?: readonly TokenRecord[];
	readonly [key: string]: unknown;
}

export interface MintedToken {
	readonly token: string;
	readonly record: TokenRecord;
}

/** The prefix makes a leaked token recognisable in a log or a screenshot. */
const TOKEN_PREFIX = "mason_";

export function configPath(home: string): string {
	return join(home, "config.json");
}

export async function readConfig(home: string): Promise<MasonConfig> {
	try {
		const parsed: unknown = JSON.parse(await readFile(configPath(home), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		const config = parsed as MasonConfig;
		// A hand-edited file with a typo must not lock Denis out: an unusable token list reads as "no tokens".
		const tokens = Array.isArray(config.tokens) ? config.tokens.filter(isTokenRecord) : [];
		return { ...config, tokens };
	} catch {
		return {};
	}
}

function isTokenRecord(value: unknown): value is TokenRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.label === "string" &&
		typeof record.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(record.sha256) &&
		typeof record.createdAt === "string"
	);
}

/**
 * Write the config atomically and privately. The rename means a crash mid-write leaves the previous tokens in place,
 * and the modes are set on the directory too: `~/.mason` holds the agent's soul and its credentials.
 */
async function writeConfig(home: string, config: MasonConfig): Promise<void> {
	await mkdir(home, { recursive: true, mode: 0o700 });
	const temporary = `${configPath(home)}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, configPath(home));
	await chmod(dirname(configPath(home)), 0o700).catch(() => {});
	await chmod(configPath(home), 0o600).catch(() => {});
}

export function readTokens(config: MasonConfig): readonly TokenRecord[] {
	return config.tokens ?? [];
}

export async function listTokens(home: string): Promise<readonly TokenRecord[]> {
	return readTokens(await readConfig(home));
}

/** Mint a token for one device. The plaintext is in the return value and nowhere else. */
export async function mintToken(home: string, label: string): Promise<MintedToken> {
	const config = await readConfig(home);
	const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
	const record: TokenRecord = {
		id: `tok_${randomBytes(4).toString("hex")}`,
		label: label.trim() === "" ? "device" : label.trim(),
		sha256: digest(token),
		createdAt: new Date().toISOString(),
	};
	await writeConfig(home, { ...config, tokens: [...readTokens(config), record] });
	return { token, record };
}

/** Remove one credential. `false` when no such id: a typo must not read as a successful revoke. */
export async function revokeToken(home: string, id: string): Promise<boolean> {
	const config = await readConfig(home);
	const remaining = readTokens(config).filter((record) => record.id !== id);
	if (remaining.length === readTokens(config).length) return false;
	await writeConfig(home, { ...config, tokens: remaining });
	return true;
}

/**
 * The token a first run hands out. A home with no credentials gets one, because a server nobody can reach is not
 * safer, it is broken: the alternative to a token on first run is a server that refuses the person who owns it.
 */
export async function ensureToken(
	home: string,
	label = "browser",
): Promise<{ readonly token?: string; readonly records: readonly TokenRecord[] }> {
	const config = await readConfig(home);
	const existing = readTokens(config);
	if (existing.length > 0) return { records: existing };
	const minted = await mintToken(home, label);
	return { token: minted.token, records: [minted.record] };
}

function digest(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time: a wrong token and a right-but-short one must cost the same to reject. */
export function verifyToken(records: readonly TokenRecord[], presented: string | undefined): TokenRecord | undefined {
	if (presented === undefined || presented.length < TOKEN_PREFIX.length + 16) return undefined;
	const presentedDigest = Buffer.from(digest(presented), "hex");
	for (const record of records) {
		const stored = Buffer.from(record.sha256, "hex");
		if (stored.length === presentedDigest.length && timingSafeEqual(stored, presentedDigest)) return record;
	}
	return undefined;
}

/**
 * The token a request presents: a bearer header (native clients, curl, tests), else the query string (a browser
 * cannot set headers on a WebSocket, and this is the one place it has to carry a credential).
 */
export function presentedToken(request: IncomingMessage): string | undefined {
	const header = request.headers.authorization;
	if (typeof header === "string") {
		const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
		if (match !== null) return match[1];
	}
	const url = new URL(request.url ?? "/", "http://localhost");
	const query = url.searchParams.get("token");
	return query === null || query === "" ? undefined : query;
}

/**
 * Whether the page that opened this request is one of ours.
 *
 * `Origin` absent means a program, not a page: curl, the native app, a test — the token is the only gate there.
 * `Origin: null` (a sandboxed frame, a `file://` page) is refused: it is a page, and not one of ours.
 */
export function originAllowed(request: IncomingMessage): boolean {
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	const host = request.headers.host;
	if (host === undefined) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

export type AuthFailure = "origin" | "token";

export type AuthResult = { readonly ok: true; readonly token: TokenRecord } | { readonly ok: false; readonly reason: AuthFailure };

export function authenticate(request: IncomingMessage, records: readonly TokenRecord[]): AuthResult {
	if (!originAllowed(request)) return { ok: false, reason: "origin" };
	const token = verifyToken(records, presentedToken(request));
	return token === undefined ? { ok: false, reason: "token" } : { ok: true, token };
}

/**
 * The links to open, once per browser or device: the loopback one always, the LAN ones when the server is bound to
 * every interface (the phone case). The token rides in the URL because the first visit is the only time a human is
 * holding it; the client stores it and drops it from the address bar.
 */
export function pairingUrls(hostname: string, port: number, token: string, limit = 4): readonly string[] {
	const hosts = [hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname];
	if (hostname === "0.0.0.0" || hostname === "::") {
		for (const address of lanAddresses()) hosts.push(address);
	}
	return hosts.slice(0, limit).map((host) => `http://${host}:${port}/?token=${encodeURIComponent(token)}`);
}

function lanAddresses(): readonly string[] {
	const addresses: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			// `internal` is the loopback, already in the list; IPv6 LAN literals need brackets and are not worth it yet.
			if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
		}
	}
	return addresses;
}
