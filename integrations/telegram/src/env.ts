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
import { DEFAULT_DATA_DIR, DEFAULT_MCP_PORT } from "./constants.ts";

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
	/** The chats this bot may relay. Anything else is dropped before it becomes an event. */
	readonly allowedChats: readonly string[];
	/** `HTTPS_PROXY` for Telegram's API, or undefined for a direct route. */
	readonly httpsProxy: string | undefined;
	/** The volume this container keeps its offset in. */
	readonly dataDir: string;
	/** The MCP endpoint's port. Fixed at 8082 in the compose template; a variable here only so a test can move it. */
	readonly port: number;
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
				`chat ids it may relay, comma-separated.`,
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
		.filter((chat) => chat !== "");
	if (allowedChats.length === 0) {
		throw new ConfigError(
			"refusing to start: TELEGRAM_ALLOWED_CHATS names no chat, and a bot with no allowlist would relay every " +
				"chat it is in. List the chat ids it may relay, comma-separated.",
		);
	}

	const port = Number(environment.PORT === undefined || environment.PORT === "" ? DEFAULT_MCP_PORT : environment.PORT);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new ConfigError(`refusing to start: PORT is not a port number: ${String(environment.PORT)}`);
	}

	const httpsProxy = (environment.HTTPS_PROXY ?? "").trim();
	return {
		botToken: value("TELEGRAM_BOT_TOKEN"),
		eventUrl,
		triggerSecret,
		allowedChats,
		httpsProxy: httpsProxy === "" ? undefined : httpsProxy,
		dataDir: (environment.DATA_DIR ?? "").trim() === "" ? DEFAULT_DATA_DIR : (environment.DATA_DIR ?? "").trim(),
		port,
	};
}
