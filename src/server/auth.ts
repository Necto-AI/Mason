/**
 * Who may talk to mason.
 *
 * One owner, a few named credentials, and every entry point proving it: the Chord socket and `/api/*`. A
 * token is minted once (`npm run token -- add --label phone`), shown once, and stored as a hash in
 * `~/.mason/service/config.json` (mode 0600) — that file is exactly the kind of thing that ends up pasted into a bug report,
 * so it must not hold a live credential.
 *
 * Three gates, answering different questions:
 *
 * - the **token** says *which device* is calling, so a lost phone is revoked without breaking the browser;
 * - the **Origin** check says *which page* opened the socket. A page on `evil.example` cannot read this origin's
 *   storage, so it cannot learn a credential; the check is the belt to that pair of braces, and it also stops a page
 *   from opening a socket at all. Native app clients send no `Origin` and pass on their token alone;
 * - the **session cookie** says *this browser already paired*. The token is a bootstrap credential: it is spent once
 *   in a URL and exchanged for a signed cookie, so the long-lived thing a page's scripts can reach holds no secret.
 *   The cookie names a token id, so revoking the token kills its sessions in the same breath.
 *
 * A cookie may also name a **person** from the roster (`roster.ts`). That is a claim, not an authentication: the join
 * screen lets anyone holding a token pick any name on the list, which is the trade a five-person team makes knowingly.
 * What the cookie buys is that the claim is the server's — signed, stable across reloads, and carried into every turn
 * as the author of what was said — rather than a string a client sends with each message.
 *
 * Tokens are read from the config on every request rather than cached at startup: `revoke` has to take effect while
 * the server is running, because a lost phone is exactly when nobody wants to restart. The file is a kilobyte.
 *
 * Nothing here is a transport. On a non-loopback address the token crosses the network in clear text until the
 * machine boundary (#20) brings TLS: an SSH tunnel or a TLS proxy is the honest answer before then.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import { isOperatorGrant, type OperatorGrant } from "../shared/admin.ts";
import { writeFileAtomic } from "./atomic.ts";
import { housePaths } from "./house.ts";

/** A named credential. The token itself exists only in the hand of whoever minted it. */
export interface TokenRecord {
	readonly id: string;
	/** What this credential is for, e.g. `browser`, `phone`. Shown by `npm run token -- list`. */
	readonly label: string;
	/** SHA-256 of the token, hex. Never the token. */
	readonly sha256: string;
	readonly createdAt: string;
	/**
	 * What this device may read and do in the panel. Absent on a record written before grants existed, which is why every
	 * reader goes through `grantsOf`: a file that predates this key grants nothing until the operator migrates it.
	 */
	readonly grants?: readonly OperatorGrant[];
}

/** Whether a grant set covers a power. Re-exported here so a reader of the credential file needs one import. */
export { grantsOf, hasGrant, OPERATOR_GRANTS } from "../shared/admin.ts";

/** `~/.mason/service/config.json`. Unknown keys are preserved: this file grows with the agent. */
export interface MasonConfig {
	readonly tokens?: readonly TokenRecord[];
	/**
	 * The credentials mason issued to connectors (`connectors.ts`). Beside the tokens because they are the same kind of
	 * thing: a hash, a label and a moment, and never the credential itself.
	 */
	readonly connectors?: readonly unknown[];
	/** HMAC key that signs browser session cookies. Generated alongside the first token, and never shown. */
	readonly sessionKey?: string;
	readonly [key: string]: unknown;
}

export interface MintedToken {
	readonly token: string;
	readonly record: TokenRecord;
}

/** The prefix makes a leaked token recognisable in a log or a screenshot. */
const TOKEN_PREFIX = "mason_";

/** The browser's cookie. `HttpOnly`, so a script on this origin cannot read it — which is the whole point of it. */
export const SESSION_COOKIE = "mason_session";
const SESSION_VERSION = "v1";
/** A session that also names a person from the roster. `v1` cookies keep working: they are a device, just unnamed. */
const SESSION_VERSION_PERSON = "v2";
/** 30 days: a phone that re-pairs every morning is a phone nobody uses. Revoking the token ends it immediately. */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** `service/config.json`: the server's half of the home, which no tool ever sees. */
export function configPath(home: string): string {
	return housePaths(home).config;
}

export async function readConfig(home: string): Promise<MasonConfig> {
	try {
		const parsed: unknown = JSON.parse(await readFile(configPath(home), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		const config = parsed as MasonConfig;
		// A hand-edited file with a typo must not lock Denis out: an unusable token list reads as "no tokens".
		const tokens = Array.isArray(config.tokens) ? config.tokens.filter(isTokenRecord) : [];
		// A key that cannot be one is dropped rather than used: an unusable session key fails closed, at the door.
		const { sessionKey: declared, ...rest } = config;
		const sessionKey = isSessionKey(declared) ? declared : undefined;
		return { ...rest, tokens, ...(sessionKey === undefined ? {} : { sessionKey }) };
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

function isSessionKey(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{43,}$/.test(value);
}

/**
 * Write the config atomically and privately. A crash mid-write leaves the previous tokens in place, and the file and its
 * directory are `0600`/`0700` (`atomic.ts`): this is the one file whose leak is a working credential.
 */
export async function writeConfig(home: string, config: MasonConfig): Promise<void> {
	await writeFileAtomic(configPath(home), config);
}

export function readTokens(config: MasonConfig): readonly TokenRecord[] {
	return config.tokens ?? [];
}

export async function listTokens(home: string): Promise<readonly TokenRecord[]> {
	return readTokens(await readConfig(home));
}

/** The cookie-signing key, minted once per home and kept where the tokens are kept. */
async function ensureSessionKey(home: string): Promise<string> {
	const config = await readConfig(home);
	if (config.sessionKey !== undefined) return config.sessionKey;
	const key = randomBytes(32).toString("base64url");
	await writeConfig(home, { ...config, sessionKey: key });
	return key;
}

/**
 * Mint a token for one device. The plaintext is in the return value and nowhere else.
 *
 * The default is the panel's read-only reading of the conversation: the narrowest grant that still shows the device
 * something. Administration and approval are asked for explicitly, by the command or by the panel.
 */
export async function mintToken(
	home: string,
	label: string,
	grants: readonly OperatorGrant[] = ["conversation"],
): Promise<MintedToken> {
	const config = await readConfig(home);
	const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
	const record: TokenRecord = {
		id: `tok_${randomBytes(4).toString("hex")}`,
		label: label.trim() === "" ? "device" : label.trim(),
		sha256: digest(token),
		createdAt: new Date().toISOString(),
		grants: grants.filter(isOperatorGrant),
	};
	await ensureSessionKey(home);
	await writeConfig(home, { ...(await readConfig(home)), tokens: [...readTokens(config), record] });
	return { token, record };
}

/**
 * Rewrite one credential's grants. `undefined` when there is no such id: a typo must not read as a change. The file is
 * read per request, so a narrowing lands on the next one — including on the device being narrowed.
 */
export async function setTokenGrants(
	home: string,
	id: string,
	grants: readonly OperatorGrant[],
): Promise<TokenRecord | undefined> {
	const config = await readConfig(home);
	const existing = readTokens(config).find((record) => record.id === id);
	if (existing === undefined) return undefined;
	const record: TokenRecord = { ...existing, grants: grants.filter(isOperatorGrant) };
	await writeConfig(home, {
		...config,
		tokens: readTokens(config).map((entry) => (entry.id === id ? record : entry)),
	});
	return record;
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
 * The grants a credential written before grants existed is given, once, by `npm run doctor -- migrate`.
 *
 * The console could read the conversation, answer a question and administer the deployment, and every credential that
 * predates the panel was handed out for exactly that. The migration keeps the deployment working — a home where no
 * device may administer is a home nobody can fix — and `trace` is deliberately not in it: the raw view is a new power,
 * granted to a device on purpose rather than inherited from a console that never had one.
 */
export const MIGRATED_GRANTS: readonly OperatorGrant[] = ["conversation", "admin", "approve"];

/**
 * Stamp the grants onto every credential that has none, in one write.
 *
 * One-way and idempotent: a record that already carries grants is left exactly as it is, including one an operator
 * narrowed by hand. A home with no tokens is not a home to fix — the boot mints one, with grants.
 */
export async function migrateTokenGrants(
	home: string,
): Promise<readonly { readonly id: string; readonly label: string }[]> {
	const config = await readConfig(home);
	const records = readTokens(config);
	const missing = records.filter((record) => !Array.isArray(record.grants));
	if (missing.length === 0) return [];
	await writeConfig(home, {
		...config,
		tokens: records.map((record) => (Array.isArray(record.grants) ? record : { ...record, grants: MIGRATED_GRANTS })),
	});
	return missing.map((record) => ({ id: record.id, label: record.label }));
}

/** Whether a config still holds a credential the panel cannot use: what the boot says out loud. */
export async function tokensWithoutGrants(home: string): Promise<readonly TokenRecord[]> {
	return readTokens(await readConfig(home)).filter((record) => !Array.isArray(record.grants));
}

/**
 * The token a first run hands out. A home with no credentials gets one, because a server nobody can reach is not
 * safer, it is broken: the alternative to a token on first run is a server that refuses the person who owns it.
 */
export async function ensureToken(
	home: string,
	label = "browser",
): Promise<{ readonly token?: string; readonly records: readonly TokenRecord[]; readonly sessionKey: string }> {
	const sessionKey = await ensureSessionKey(home);
	const existing = await readTokens(await readConfig(home));
	if (existing.length > 0) return { records: existing, sessionKey };
	// The first credential of a fresh home is the one person's own: it administers the panel, reads the conversation and
	// answers approvals. The trace is not in it — an operator who wants the machine's working notes grants them to a
	// device on purpose, which is one click in the panel (or `npm run token -- grants <id> conversation,trace`).
	const minted = await mintToken(home, label, ["conversation", "admin", "approve"]);
	return { token: minted.token, records: [minted.record], sessionKey };
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
 * The token a request presents: a bearer header (native clients, curl, a script), else the query string (a
 * browser cannot set a header on a WebSocket, and a pairing link is a URL).
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

/** What a session cookie names once it is opened: the device it was paired for, and the person it claims to be. */
export interface SessionSubject {
	readonly tokenId: string;
	readonly person?: string;
}

/**
 * The session a pairing link is exchanged for: `<version>.<token id>.<person>.<HMAC>`.
 *
 * It carries no secret — the id names a record in the config, the person a name in the roster, and the HMAC keeps
 * either from being invented — so a stolen cookie is worth exactly one device's access, and it dies when that device's
 * token is revoked or that person is removed from the roster.
 *
 * The person is base64url so a name with a dot in it cannot be read as the signature.
 */
export function sealSession(sessionKey: string, tokenId: string, person?: string): string {
	if (person === undefined) {
		const material = `${SESSION_VERSION}:${tokenId}`;
		const signature = createHmac("sha256", sessionKey).update(material, "utf8").digest("base64url");
		return `${SESSION_VERSION}.${tokenId}.${signature}`;
	}
	const encoded = Buffer.from(person, "utf8").toString("base64url");
	const material = `${SESSION_VERSION_PERSON}:${tokenId}:${person}`;
	const signature = createHmac("sha256", sessionKey).update(material, "utf8").digest("base64url");
	return `${SESSION_VERSION_PERSON}.${tokenId}.${encoded}.${signature}`;
}

/** What a session cookie names, or `undefined` for anything that is not one this home signed. */
export function openSession(sessionKey: string, value: string): SessionSubject | undefined {
	const parts = value.split(".");
	if (parts[0] === SESSION_VERSION && parts.length === 3) {
		const [, tokenId, signature] = parts as [string, string, string];
		if (!signatureMatches(sessionKey, `${SESSION_VERSION}:${tokenId}`, signature)) return undefined;
		return { tokenId };
	}
	if (parts[0] === SESSION_VERSION_PERSON && parts.length === 4) {
		const [, tokenId, encoded, signature] = parts as [string, string, string, string];
		const person = Buffer.from(encoded, "base64url").toString("utf8");
		// The name is inside the signed material, so a cookie cannot be decoded into a different person.
		if (!signatureMatches(sessionKey, `${SESSION_VERSION_PERSON}:${tokenId}:${person}`, signature)) return undefined;
		return { tokenId, person };
	}
	return undefined;
}

/** Constant-time, and length-checked first: a malformed signature must cost the same as a wrong one. */
function signatureMatches(sessionKey: string, material: string, signature: string): boolean {
	const expected = createHmac("sha256", sessionKey).update(material, "utf8").digest();
	let presented: Buffer;
	try {
		presented = Buffer.from(signature, "base64url");
	} catch {
		return false;
	}
	return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** One cookie out of a `Cookie` header. First match wins; this header is a list, not a map. */
export function cookieValue(header: string | undefined, name = SESSION_COOKIE): string | undefined {
	if (header === undefined) return undefined;
	for (const pair of header.split(";")) {
		const separator = pair.indexOf("=");
		if (separator === -1) continue;
		if (pair.slice(0, separator).trim() !== name) continue;
		return pair.slice(separator + 1).trim();
	}
	return undefined;
}

/** `Set-Cookie` for a paired browser. `Secure` only where the connection already is TLS, or the cookie is dropped. */
export function sessionCookieValue(sessionKey: string, tokenId: string, secure: boolean, person?: string): string {
	const attributes = [
		`${SESSION_COOKIE}=${sealSession(sessionKey, tokenId, person)}`,
		"Path=/",
		// Opaque to scripts on purpose. The shell never reads it: it asks `/api/session`, and the server answers from the
		// cookie it already parsed — so the join screen learns the name without the page holding a handle on it.
		"HttpOnly",
		// Strict is the CSRF defence that does not depend on the Origin gate: a cross-site request never carries it.
		"SameSite=Strict",
		`Max-Age=${SESSION_MAX_AGE_SECONDS}`,
	];
	if (secure) attributes.push("Secure");
	return attributes.join("; ");
}

function requestIsSecure(request: IncomingMessage): boolean {
	if ((request.socket as { encrypted?: boolean }).encrypted === true) return true;
	const forwarded = request.headers["x-forwarded-proto"];
	const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	return value?.split(",")[0]?.trim().toLowerCase() === "https";
}

/** The device a request's session cookie names, if that cookie was signed here and its token still exists. */
export function deviceFromCookie(
	request: IncomingMessage,
	config: MasonConfig,
): { readonly token: TokenRecord; readonly person?: string } | undefined {
	const sessionKey = config.sessionKey;
	if (sessionKey === undefined) return undefined;
	const value = cookieValue(request.headers.cookie);
	if (value === undefined) return undefined;
	const subject = openSession(sessionKey, value);
	if (subject === undefined) return undefined;
	const token = readTokens(config).find((record) => record.id === subject.tokenId);
	if (token === undefined) return undefined;
	return subject.person === undefined ? { token } : { token, person: subject.person };
}

export type AuthFailure = "origin" | "token";

type AuthSuccess = { readonly ok: true; readonly token: TokenRecord; readonly person?: string };

export type AuthResult = AuthSuccess | { readonly ok: false; readonly reason: AuthFailure };

/**
 * The credentials a running server consults. It is the config file, read per request: a mint or a revoke while the
 * server runs is visible to the very next request, and there is no cache to go stale.
 */
export interface TokenStore {
	config(): Promise<MasonConfig>;
	records(): Promise<readonly TokenRecord[]>;
}

export function createTokenStore(home: string): TokenStore {
	return {
		config: () => readConfig(home),
		records: async () => readTokens(await readConfig(home)),
	};
}

/**
 * Which device is calling. Four ways in, tried in the order a client would use them: a bearer token (native app,
 * curl), the query string (a pairing link, or a socket where a header is impossible), the session cookie
 * (a paired browser), and nothing else.
 */
export async function authenticate(request: IncomingMessage, store: TokenStore): Promise<AuthResult> {
	if (!originAllowed(request)) return { ok: false, reason: "origin" };
	const config = await store.config();
	const direct = verifyToken(readTokens(config), presentedToken(request));
	if (direct !== undefined) return { ok: true, token: direct };
	const paired = deviceFromCookie(request, config);
	if (paired === undefined) return { ok: false, reason: "token" };
	return paired.person === undefined
		? { ok: true, token: paired.token }
		: { ok: true, token: paired.token, person: paired.person };
}

/**
 * A pairing link: the one time a token travels in a URL. A valid one is spent here — the caller sets the cookie and
 * redirects to the same page without it, so the address bar, the history and the `Referer` never hold a credential.
 */
export async function pairingFromRequest(
	request: IncomingMessage,
	url: URL,
	store: TokenStore,
): Promise<{ readonly tokenId: string; readonly cookie: string } | undefined> {
	const presented = url.searchParams.get("token");
	if (presented === null || presented === "") return undefined;
	const config = await store.config();
	const record = verifyToken(readTokens(config), presented);
	if (record === undefined || config.sessionKey === undefined) return undefined;
	return {
		tokenId: record.id,
		cookie: sessionCookieValue(config.sessionKey, record.id, requestIsSecure(request)),
	};
}

/**
 * The links to open, once per browser or device: the loopback one always, the LAN ones when the server is bound to
 * every interface (the phone case). The token rides in the URL because the first visit is the only time a human is
 * holding it; the server spends it into a cookie and redirects to the bare path.
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
