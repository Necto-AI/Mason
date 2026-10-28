/**
 * What this container is configured with: the environment, and nothing else.
 *
 * An integration holds its own upstream credential (ADR-0003), and a bot token is exactly that — it lives in this
 * container's environment, in `deploy/.env` beside the compose file, and in no file the container writes. The mason half
 * is two values: where the event door is, and the secret that signs what is posted there. Neither can speak as the
 * owner: a trigger secret buys one verb, one hook fire.
 *
 * A missing variable is a refusal at startup that names it, because the failure of a half-configured integration is
 * silent. An instance without its allowlist would relay every chat the bot happens to be in; one without its secret
 * would deliver events that nothing accepts, and advance its offset past every one of them. Refusing to start is also
 * what a container supervisor understands: `restart: unless-stopped` retries, and the log says what to set.
 */
import { DEFAULT_DATA_DIR, DEFAULT_INBOX_DIR, DEFAULT_MCP_PORT, INBOX_PATH_MAX_BYTES } from "./constants.ts";

/** Every variable the trigger face cannot run without. A name here is a name the refusal prints. */
export const REQUIRED_VARIABLES = [
	"TELEGRAM_BOT_TOKEN",
	"MASON_EVENT_URL",
	"MASON_TRIGGER_SECRET",
	"TELEGRAM_ALLOWED_CHATS",
] as const;

/**
 * A trigger secret shorter than this is a guess away from being no door. The same floor as `src/server/integrations.ts`
 * enforces on the mason side, because a secret the door would accept is minted there (`npm run integration -- secret`)
 * and a shorter one would be a secret this container took but mason never issued.
 */
const TRIGGER_SECRET_MIN = 32;

/**
 * A Telegram username without its leading @. The shape is Telegram's own, and it is checked here because an entry that is
 * neither a chat id nor a well-formed username can only ever match nothing: the bot would start and relay nobody, which
 * is the silent half-configured instance this file exists to refuse.
 */
const USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/;

/** A chat id as Telegram writes it, negative for a group or a channel: what this list has always taken. */
const CHAT_ID_PATTERN = /^-?\d+$/;

/** Configuration mason cannot run with. The message is written for the operator who has to fix `.env`. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export interface Config {
	/** The bot's own credential. Never logged, never written, never inside a payload. */
	readonly botToken: string;
	/** Where an event is posted: `http://mason:8787/api/events/telegram` on the compose network. */
	readonly eventUrl: string;
	/** The HMAC key the door verifies with. Never logged. */
	readonly triggerSecret: string;
	/**
	 * The chats this bot may relay, by chat id or by the sender's @username. Anything else is dropped before it becomes
	 * an event.
	 */
	readonly allowedChats: readonly string[];
	/** `HTTPS_PROXY` for Telegram's API, or undefined for a direct route. */
	readonly httpsProxy: string | undefined;
	/**
	 * Where a voice note's bytes are posted for transcription, or undefined for none. Optional in the strict sense: without
	 * it a voice note reaches the agent as a file and a sentence, exactly as it did before this was a setting. It is a
	 * service on the relay's own network rather than Telegram's API, so it is called directly and never through the proxy.
	 */
	readonly asrUrl: string | undefined;
	/** The volume this container keeps its offset in. */
	readonly dataDir: string;
	/** Where an attachment is written: a directory the tool machine mounts at this same path, so a payload's path opens. */
	readonly inboxDir: string;
	/** The MCP endpoint's port. Fixed at 8082 in the compose template; a variable here only so a test can move it. */
	readonly port: number;
}

/**
 * One allowlist entry as the filter compares it: a chat id unchanged, or a username folded to lower case, because a
 * Telegram username is case-insensitive and one spelling in `.env` has to match every case Telegram sends. A leading @ is
 * what says an entry is a person; an entry without one has to be a chat id, and anything else is refused here so that the
 * log names the entry rather than the bot silently ignoring every message.
 */
function allowedEntry(entry: string): string {
	if (!entry.startsWith("@")) {
		if (CHAT_ID_PATTERN.test(entry)) return entry;
		throw new ConfigError(
			`refusing to start: TELEGRAM_ALLOWED_CHATS names ${entry}, which is not a chat id and has no leading @. ` +
				`An entry is a chat id (-1001234) or a username (@kareva_tanya), comma-separated.`,
		);
	}
	const username = entry.slice(1);
	if (!USERNAME_PATTERN.test(username)) {
		throw new ConfigError(
			`refusing to start: TELEGRAM_ALLOWED_CHATS names ${entry}, and a username is @ followed by 5-32 letters, ` +
				`digits or underscores.`,
		);
	}
	return `@${username.toLowerCase()}`;
}

function isHttpUrl(candidate: string): boolean {
	try {
		const url = new URL(candidate);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Read, validate, or refuse. One function, so every reason this container will not start is in one place and a test can
 * read it without a process.
 */
export function readConfig(environment: Record<string, string | undefined>): Config {
	const value = (name: string): string => (environment[name] ?? "").trim();
	const missing = REQUIRED_VARIABLES.filter((name) => value(name) === "");
	if (missing.length > 0) {
		throw new ConfigError(
			`refusing to start: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
				`The bot token and the door's URL and secret are the integration; TELEGRAM_ALLOWED_CHATS is the list of ` +
				`chat ids or @usernames it may relay, comma-separated.`,
		);
	}

	const triggerSecret = value("MASON_TRIGGER_SECRET");
	if (triggerSecret.length < TRIGGER_SECRET_MIN) {
		throw new ConfigError(
			`refusing to start: MASON_TRIGGER_SECRET is ${triggerSecret.length} characters, and ${TRIGGER_SECRET_MIN} is ` +
				`the floor. The door mints it: npm run integration -- secret telegram`,
		);
	}

	const eventUrl = value("MASON_EVENT_URL");
	if (!isHttpUrl(eventUrl)) {
		throw new ConfigError(`refusing to start: MASON_EVENT_URL is not an http(s) URL: ${eventUrl}`);
	}

	const allowedChats = value("TELEGRAM_ALLOWED_CHATS")
		.split(",")
		.map((chat) => chat.trim())
		.filter((chat) => chat !== "")
		.map(allowedEntry);
	if (allowedChats.length === 0) {
		throw new ConfigError(
			"refusing to start: TELEGRAM_ALLOWED_CHATS names no chat, and a bot with no allowlist would relay every " +
				"chat it is in. List the chat ids or @usernames it may relay, comma-separated.",
		);
	}

	const port = Number(environment.PORT === undefined || environment.PORT === "" ? DEFAULT_MCP_PORT : environment.PORT);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new ConfigError(`refusing to start: PORT is not a port number: ${String(environment.PORT)}`);
	}

	const httpsProxy = (environment.HTTPS_PROXY ?? "").trim();
	// Optional, and the one optional value with a shape: an endpoint that is not an URL would fail at the first voice note
	// instead of at boot, and the log line it produced would be one every voice note rather than one an operator can fix.
	// The refusal does not print the value — unlike MASON_EVENT_URL's — because a transcription endpoint is often a LAN
	// address with a token in its path or query, and a half-typed one is exactly the case this branch sees.
	const asrUrl = value("TELEGRAM_ASR_URL");
	if (asrUrl !== "" && !isHttpUrl(asrUrl)) {
		throw new ConfigError(
			"refusing to start: TELEGRAM_ASR_URL is not an http(s) URL; it takes the whole endpoint, " +
				"as in http://asr.local:9000/transcribe",
		);
	}
	const inboxDir = value("TELEGRAM_INBOX");
	// The path is a promise to two machines: the payload names it, and the tool machine resolves it against a mount. A
	// relative one would be written under this container's working directory and read nowhere.
	if (inboxDir !== "" && !inboxDir.startsWith("/")) {
		throw new ConfigError(`refusing to start: TELEGRAM_INBOX is not an absolute path: ${inboxDir}`);
	}
	// And short enough to be printed: every payload that carries a file ends with this path, and the door refuses a
	// payload over `PAYLOAD_MAX`. A directory whose name cannot fit is a stack where every attachment reads as one that
	// could not be named, which is a setting nobody would diagnose from the message.
	if (Buffer.byteLength(inboxDir, "utf8") > INBOX_PATH_MAX_BYTES) {
		throw new ConfigError(
			`refusing to start: TELEGRAM_INBOX is longer than ${INBOX_PATH_MAX_BYTES} bytes, so a payload could not carry a path in it`,
		);
	}
	return {
		botToken: value("TELEGRAM_BOT_TOKEN"),
		eventUrl,
		triggerSecret,
		allowedChats,
		httpsProxy: httpsProxy === "" ? undefined : httpsProxy,
		asrUrl: asrUrl === "" ? undefined : asrUrl,
		dataDir: (environment.DATA_DIR ?? "").trim() === "" ? DEFAULT_DATA_DIR : (environment.DATA_DIR ?? "").trim(),
		inboxDir: inboxDir === "" ? DEFAULT_INBOX_DIR : inboxDir,
		port,
	};
}
