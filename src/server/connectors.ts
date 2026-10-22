/**
 * Connectors: another system's events, delivered as hook fires.
 *
 * A connector is not a second way to speak as the owner. It cannot read the transcript, claim a name or call a method:
 * it has one verb — deliver an event — and that verb becomes a hook fire, which is a prompt with the event fenced as
 * untrusted data (§3.3). So its credential is deliberately weaker than a token and scoped to one job: a shared secret
 * that proves a delivery came from the system it claims to be, on a route that can do nothing but fire one named hook.
 *
 * The secret lives beside the agent's own state (`connectors.json`, `0600`) rather than in `config.json`, because the
 * two answer different questions: `config.json` says who may speak as the owner, this says which sender may wake the
 * agent about an event. A leak of one is not a leak of the other.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HousePaths } from "./house.ts";

/** How much of an event's free text reaches the prompt. Enough to judge an issue, far short of the body limit. */
const TEXT_MAX = 2_000;
/** How many labels travel with an event: a wall of labels is not a summary. */
const LABELS_MAX = 12;

/** The GitHub connector as it is stored: a secret, and the one hook its deliveries may fire. */
export interface GithubConnector {
	readonly secret: string;
	readonly hookId: string;
}

/** The hook a GitHub delivery fires unless the operator names another one. */
export const GITHUB_HOOK_ID = "github-activity";

/** Where a delivery arrives. One path per connector, so the door can be decided by path alone (main.ts). */
export const GITHUB_DELIVERY_PATH = "/api/connectors/github";

type Stored = Record<string, unknown>;

export function connectorsPath(house: HousePaths): string {
	return join(house.dataDir, "connectors.json");
}

/** Every stored connector, as it is on disk. A malformed file reads as empty: no credential means no deliveries. */
export function readConnectors(house: HousePaths): Stored {
	try {
		const parsed: unknown = JSON.parse(readFileSync(connectorsPath(house), "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Stored) : {};
	} catch {
		return {};
	}
}

export function readGithubConnector(house: HousePaths): GithubConnector | undefined {
	const stored = readConnectors(house).github;
	if (typeof stored !== "object" || stored === null) return undefined;
	const { secret, hookId } = stored as { secret?: unknown; hookId?: unknown };
	if (typeof secret !== "string" || secret.length < 16) return undefined;
	return { secret, hookId: typeof hookId === "string" && hookId.length > 0 ? hookId : GITHUB_HOOK_ID };
}

/**
 * Write the connector, `0600`, through a rename so a reader never sees half a secret.
 *
 * Called by `npm run connector` and by the tests; nothing in the request path writes, so a running server only ever
 * reads this file — which is what makes `npm run connector -- set` take effect on the next delivery, without a restart.
 */
export function writeGithubConnector(house: HousePaths, connector: GithubConnector): void {
	const path = connectorsPath(house);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const next: Stored = { ...readConnectors(house), github: { secret: connector.secret, hookId: connector.hookId } };
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

/** Removes the GitHub connector; `false` when there was none. */
export function removeGithubConnector(house: HousePaths): boolean {
	if (readConnectors(house).github === undefined) return false;
	const next = readConnectors(house);
	delete next.github;
	const path = connectorsPath(house);
	if (Object.keys(next).length === 0) rmSync(path, { force: true });
	else writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	return true;
}

/** A secret generated here rather than chosen by a person: 32 bytes, hex, and never reused across connectors. */
export function mintConnectorSecret(): string {
	return randomBytes(32).toString("hex");
}

/**
 * GitHub's `X-Hub-Signature-256`: `sha256=<hex hmac of the raw body>`.
 *
 * Over the raw bytes, not the parsed JSON: re-serialising changes whitespace and key order, and the signature would
 * never match. Comparison is constant-time, because a signature check that leaks how far it got is a signature check
 * that can be guessed a byte at a time.
 */
export function verifyGithubSignature(secret: string, body: Buffer, header: string | undefined): boolean {
	if (header === undefined || !header.startsWith("sha256=")) return false;
	const claimed = Buffer.from(header.slice("sha256=".length), "hex");
	if (claimed.length !== 32) return false;
	const expected = createHmac("sha256", secret).update(body).digest();
	return timingSafeEqual(claimed, expected);
}

/** The kinds of event that are worth a turn. Everything else is acknowledged and dropped. */
const ACTIONS: Record<string, readonly string[]> = {
	issues: ["opened", "reopened", "closed"],
	pull_request: ["opened", "reopened", "closed", "ready_for_review", "review_requested"],
	pull_request_review: ["submitted"],
};

/** One issue or pull request event, compacted to what a reader needs to judge it. */
export interface GithubEvent {
	readonly source: "github";
	readonly event: string;
	readonly action: string;
	readonly repo: string;
	readonly number: number;
	readonly kind: "issue" | "pull_request";
	readonly title: string;
	readonly url: string;
	readonly actor: string;
	readonly state?: string;
	readonly draft?: boolean;
	readonly merged?: boolean;
	readonly labels: string[];
	readonly body?: string;
	readonly review?: { readonly state: string; readonly body?: string };
}

function text(value: unknown, max: number = TEXT_MAX): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function repoName(payload: Record<string, unknown>): string | undefined {
	const repo = payload.repository;
	if (typeof repo !== "object" || repo === null) return undefined;
	const full = (repo as Record<string, unknown>).full_name;
	return typeof full === "string" && full.includes("/") ? full : undefined;
}

function actorLogin(payload: Record<string, unknown>): string {
	const sender = payload.sender;
	if (typeof sender === "object" && sender !== null) {
		const login = (sender as Record<string, unknown>).login;
		if (typeof login === "string" && login.length > 0) return login;
	}
	return "unknown";
}

function labelsOf(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const names: string[] = [];
	for (const label of value) {
		if (typeof label !== "object" || label === null) continue;
		const name = (label as Record<string, unknown>).name;
		if (typeof name === "string" && name.length > 0) names.push(name);
		if (names.length === LABELS_MAX) break;
	}
	return names;
}

/**
 * The event, or `undefined` when it is not one this connector is for.
 *
 * Trigger-first: a repository emits an event for every label, comment, edit and assignment, and each one is a model
 * turn if it is forwarded. The filter is an allowlist of the moments a person would want to hear about — something
 * opened, closed, reopened, or a review asked for — rather than a denylist that has to be extended forever.
 */
export function readGithubEvent(event: string | undefined, payload: Record<string, unknown>): GithubEvent | undefined {
	if (event === undefined) return undefined;
	const allowed = ACTIONS[event];
	if (allowed === undefined) return undefined;
	const action = typeof payload.action === "string" ? payload.action : undefined;
	if (action === undefined || !allowed.includes(action)) return undefined;

	const repo = repoName(payload);
	if (repo === undefined) return undefined;

	if (event === "pull_request_review") {
		const pull = payload.pull_request;
		const review = payload.review;
		if (typeof pull !== "object" || pull === null || typeof review !== "object" || review === null) return undefined;
		const number = (pull as Record<string, unknown>).number;
		if (typeof number !== "number") return undefined;
		const record = review as Record<string, unknown>;
		const state = typeof record.state === "string" ? record.state : "commented";
		const url = text((pull as Record<string, unknown>).html_url, 500) ?? `https://github.com/${repo}/pull/${number}`;
		const reviewBody = text(record.body);
		return {
			source: "github",
			event,
			action,
			repo,
			number,
			kind: "pull_request",
			title: text((pull as Record<string, unknown>).title, 500) ?? `#${number}`,
			url,
			actor: actorLogin(payload),
			state,
			labels: [],
			...(reviewBody === undefined ? {} : { body: reviewBody }),
			review: { state, ...(reviewBody === undefined ? {} : { body: reviewBody }) },
		};
	}

	const subject = event === "issues" ? payload.issue : payload.pull_request;
	if (typeof subject !== "object" || subject === null) return undefined;
	const record = subject as Record<string, unknown>;
	const number = record.number;
	if (typeof number !== "number") return undefined;
	const kind = event === "issues" ? "issue" : "pull_request";
	const url =
		text(record.html_url, 500) ??
		`https://github.com/${repo}/${kind === "issue" ? "issues" : "pull"}/${number}`;
	const state = typeof record.state === "string" ? record.state : undefined;
	const body = text(record.body);
	const draft = typeof record.draft === "boolean" ? record.draft : undefined;
	const merged = typeof record.merged === "boolean" ? record.merged : undefined;

	return {
		source: "github",
		event,
		action,
		repo,
		number,
		kind,
		title: text(record.title, 500) ?? `#${number}`,
		url,
		actor: actorLogin(payload),
		...(state === undefined ? {} : { state }),
		...(draft === undefined ? {} : { draft }),
		...(merged === undefined ? {} : { merged }),
		labels: labelsOf(record.labels),
		...(body === undefined ? {} : { body }),
	};
}

/** What a hook's prompt template receives: the compacted event, as JSON, fenced by the hooks engine. */
export function githubPayload(event: GithubEvent): string {
	return JSON.stringify(event);
}
