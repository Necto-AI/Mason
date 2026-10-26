/**
 * One line per thing that happened, and never a credential inside it.
 *
 * This container holds two secrets — the bot token and the trigger secret — and a container's log is the least
 * controlled place either could end up: it is collected, shipped and pasted into bugs. So the logger is the one door
 * they pass through, and it redacts on the way out rather than trusting every call site to remember.
 *
 * The token is the harder case, because it is not only a value this process knows: it is a path segment of every URL
 * Telegram is called at (`/bot<id>:<secret>/sendMessage`), so a URL that leaks into a message — an undici error naming
 * the request, a `fetch failed` cause — carries it. The pattern below catches that shape as well as the literal value,
 * and it catches an `Authorization` header, which is what a proxy error tends to quote back.
 */

export type LogLevel = "info" | "warn" | "error";

/** Somewhere a line goes. `console` in the container, an array in a test. */
export type LogSink = (line: string) => void;

export type Log = (level: LogLevel, message: string) => void;

/** What a bearer credential looks like in a quoted header, scheme and all, in a few spellings. */
const AUTHORIZATION = /(\bauthorization\b["']?\s*[:=]\s*)((?:(?:bearer|basic|token|digest)\s+)?("[^"]*"|'[^']*'|\S+))/gi;

/** Telegram's own URL shape, whether or not the token reached this process as a configured secret. */
const BOT_URL_TOKEN = /\/bot\d+:[A-Za-z0-9_-]+/g;

/** Replace every secret this process knows, and the two shapes a secret arrives in without being one of them. */
export function redact(text: string, secrets: readonly string[]): string {
	let redacted = text;
	for (const secret of secrets) {
		// A one-character secret would match everywhere; nothing here is ever that short, and skipping is honest.
		if (secret.length < 8) continue;
		redacted = redacted.replaceAll(secret, "<redacted>");
	}
	return redacted
		.replace(AUTHORIZATION, "$1<redacted>")
		.replace(BOT_URL_TOKEN, "/bot<redacted>");
}

export function createLog(secrets: readonly string[], sink: LogSink = (line) => console.log(line)): Log {
	return (level, message) => {
		const prefix = level === "info" ? "" : `${level}: `;
		sink(`[telegram] ${prefix}${redact(message, secrets)}`);
	};
}

/**
 * A wait as a log line states it: whole seconds and an `s`. One helper, so the two lines about a single wait — the one
 * naming what was asked and the one naming what was waited — never disagree about it.
 */
export function formatDuration(ms: number): string {
	return `${Math.round(ms / 1_000)}s`;
}

/**
 * An unknown thrown value as one line, with the cause it was hiding.
 *
 * `Error` loses its stack on purpose: a log line is a line. The cause does not go with it, though — `fetch failed` is
 * what every network problem says, and the reason (a refused connection, a name that does not resolve, a proxy that
 * answered nothing) is one level down. Without it, "the container cannot reach Telegram" is all a log ever says.
 */
export function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause: unknown = error.cause;
	const reason = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
	if (reason === "" || reason === error.message) return error.message;
	return `${error.message}: ${reason}`;
}
