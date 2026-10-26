/**
 * Telegram's HTTP API, as much of it as this container uses: getMe, getUpdates, sendMessage.
 *
 * Three decisions live here.
 *
 * **The token is in the URL.** Telegram has no header form, so the credential is a path segment of every call. That is
 * why nothing in this file puts a URL into an error: a `fetch failed` wrapped around one would print the bot's token into
 * the container log, and the log is the least controlled place it could land. Errors carry the method, the status and
 * Telegram's own description; `src/log.ts` redacts the shapes that slip through anyway.
 *
 * **A 429 is an answer, not a failure.** Telegram answers `{ok: false, error_code: 429, parameters: {retry_after: n}}`
 * and means it: come back in n seconds. `sendMessage` therefore returns an outcome rather than throwing, so the caller
 * that owns waiting (`src/queue.ts`) can honour the number instead of retrying into a longer ban. Every other non-ok
 * answer is a failure with a description to log.
 *
 * **Request and response bodies are declared, not inferred.** This is the vendor's protocol at one version; the fields
 * below are the ones a relay needs, and the rest of what Telegram sends is ignored rather than modelled.
 */
import { describeError, redact } from "./log.ts";

/**
 * The one call shape this package makes: a URL, a method, headers, and an optional body.
 *
 * The response is declared by the handful of members this package reads rather than as the platform's `Response`, because
 * there are two of those — Node's `fetch` and the `undici` client the proxy route goes through — and they are
 * structurally compatible but not the same type. A narrower interface is what lets `src/fetch.ts` offer both without a
 * cast, and it is also a true statement of what this container depends on.
 */
export type Fetch = (url: string, request: FetchRequest) => Promise<FetchResponse>;

export interface FetchResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly statusText: string;
	text(): Promise<string>;
}

export interface FetchRequest {
	readonly method: "GET" | "POST";
	readonly headers: Record<string, string>;
	readonly body?: string;
	readonly signal?: AbortSignal;
}

/** Telegram's default origin. A field rather than a constant in the call, so a test can point the client at nothing. */
export const TELEGRAM_API = "https://api.telegram.org";

export interface TelegramUser {
	readonly id: number;
	readonly is_bot?: boolean;
	readonly first_name: string;
	readonly last_name?: string;
	readonly username?: string;
}

export interface TelegramChat {
	readonly id: number;
	readonly type: string;
	readonly title?: string;
	readonly username?: string;
	readonly first_name?: string;
	readonly last_name?: string;
}

export interface TelegramMessage {
	readonly message_id: number;
	readonly from?: TelegramUser;
	readonly chat: TelegramChat;
	readonly date: number;
	readonly text?: string;
	readonly reply_to_message?: { readonly message_id: number };
}

/** One `getUpdates` entry. `allowed_updates: ["message"]` is what keeps the other kinds away. */
export interface TelegramUpdate {
	readonly update_id: number;
	readonly message?: TelegramMessage;
	/**
	 * Declared because Telegram sends it unless `allowed_updates` says otherwise, and the filter skips it on its own
	 * rather than on the strength of a request parameter it cannot see.
	 */
	readonly edited_message?: TelegramMessage;
}

/** What Telegram answered, before this file decides what it means. */
interface TelegramResponse {
	readonly ok: boolean;
	readonly result?: unknown;
	readonly description?: string;
	readonly error_code?: number;
	readonly parameters?: { readonly retry_after?: number };
}

/**
 * What one `sendMessage` came to.
 *
 * - `sent`: accepted, and the id of the message it created — the whole reason the tool returns anything.
 * - `throttled`: a 429 with Telegram's own `retry_after` in seconds. The caller may wait exactly that long and try again.
 * - `failed`: everything else, with a description a person can act on.
 */
export type SendOutcome =
	| { readonly kind: "sent"; readonly messageId: number }
	| { readonly kind: "throttled"; readonly retryAfter: number }
	| { readonly kind: "failed"; readonly error: string };

/** A call that failed in a way the trigger face cannot continue past: getMe and getUpdates. */
export class TelegramError extends Error {
	readonly code: number;
	/** Telegram's own `retry_after`, when the answer carried one. Seconds. */
	readonly retryAfter: number | undefined;

	constructor(method: string, code: number, description: string, retryAfter?: number) {
		super(`Telegram ${method} failed (${code}): ${description}`);
		this.name = "TelegramError";
		this.code = code;
		this.retryAfter = retryAfter;
	}
}

export interface SendMessageOptions {
	readonly chatId: string;
	readonly text: string;
	readonly replyToMessageId?: number;
}

export class TelegramApi {
	readonly #token: string;
	readonly #fetch: Fetch;
	readonly #baseUrl: string;

	constructor(options: { readonly token: string; readonly fetch: Fetch; readonly baseUrl?: string }) {
		this.#token = options.token;
		this.#fetch = options.fetch;
		this.#baseUrl = options.baseUrl ?? TELEGRAM_API;
	}

	/**
	 * The bot's own username, which is what `@mention` in a group resolves to. Read once at startup: it is what the
	 * mention stripper removes, and a wrong answer there leaves the agent reading its own name as part of the message.
	 */
	async getMe(): Promise<{ readonly username: string | undefined; readonly id: number }> {
		const result = await this.#call("getMe", {});
		const user = result as Partial<TelegramUser> | null;
		if (typeof user !== "object" || user === null || typeof user.id !== "number") {
			throw new TelegramError("getMe", 200, "the answer carried no user");
		}
		return { id: user.id, username: user.username };
	}

	/**
	 * One long-poll batch. `offset` is the update id to start from — Telegram confirms everything below it — and
	 * `timeout` is how long the server may hold the request open when there is nothing to say.
	 */
	async getUpdates(options: {
		readonly offset?: number;
		readonly timeout: number;
		readonly signal?: AbortSignal;
	}): Promise<TelegramUpdate[]> {
		const result = await this.#call(
			"getUpdates",
			{
				...(options.offset === undefined ? {} : { offset: options.offset }),
				timeout: options.timeout,
				// Only messages become events. Edits and every other kind never reach the filter, because Telegram is
				// told not to send them at all.
				allowed_updates: ["message"],
			},
			options.signal,
		);
		if (!Array.isArray(result)) throw new TelegramError("getUpdates", 200, "the answer carried no update list");
		return result.filter((update): update is TelegramUpdate => {
			const candidate = update as Partial<TelegramUpdate> | null;
			return typeof candidate === "object" && candidate !== null && typeof candidate.update_id === "number";
		});
	}

	async sendMessage(options: SendMessageOptions): Promise<SendOutcome> {
		let answer: FetchResponse;
		try {
			answer = await this.#fetch(this.#url("sendMessage"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					chat_id: options.chatId,
					text: options.text,
					...(options.replyToMessageId === undefined
						? {}
						: // The current field: `reply_to_message_id` is the legacy spelling, and Telegram keeps answering
							// it, but a thread-aware client reads `reply_parameters` and Telegram documents this one first.
							{ reply_parameters: { message_id: options.replyToMessageId, allow_sending_without_reply: true } }),
				}),
			});
		} catch (error) {
			return { kind: "failed", error: `request failed: ${this.#clean(error)}` };
		}
		const parsed = await readBody(answer);
		if (parsed !== undefined && parsed.parameters?.retry_after !== undefined) {
			return { kind: "throttled", retryAfter: parsed.parameters.retry_after };
		}
		if (!answer.ok || parsed === undefined || parsed.ok !== true) {
			return { kind: "failed", error: `${answer.status} ${describeAnswer(parsed) ?? answer.statusText}` };
		}
		const message = parsed.result as Partial<TelegramMessage> | null | undefined;
		if (typeof message !== "object" || message === null || typeof message.message_id !== "number") {
			return { kind: "failed", error: `${answer.status} the answer carried no message id` };
		}
		return { kind: "sent", messageId: message.message_id };
	}

	async #call(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		let answer: FetchResponse;
		try {
			answer = await this.#fetch(this.#url(method), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				...(signal === undefined ? {} : { signal }),
			});
		} catch (error) {
			throw new TelegramError(method, 0, `request failed: ${this.#clean(error)}`);
		}
		const parsed = await readBody(answer);
		const retryAfter = parsed?.parameters?.retry_after;
		if (!answer.ok || parsed === undefined || parsed.ok !== true) {
			throw new TelegramError(
				method,
				parsed?.error_code ?? answer.status,
				describeAnswer(parsed) ?? answer.statusText,
				retryAfter,
			);
		}
		return parsed.result;
	}

	#url(method: string): string {
		return `${this.#baseUrl}/bot${this.#token}/${method}`;
	}

	/**
	 * An error's text with this bot's token taken out. A client error is the one string that leaves this file without
	 * being written here, and `sendMessage`'s failure becomes the tool result the model reads — a token in the
	 * transcript is a token in the log, the UI and every backup.
	 */
	#clean(error: unknown): string {
		return redact(describeError(error), [this.#token]);
	}
}

/** Telegram answers JSON; a proxy or a captive portal answers HTML, and that is a failure rather than a parse crash. */
async function readBody(answer: FetchResponse): Promise<TelegramResponse | undefined> {
	const text = await answer.text().catch(() => "");
	if (text === "") return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as TelegramResponse;
	} catch {
		return undefined;
	}
}

/** Telegram's own sentence about what went wrong, or undefined when it sent none. */
function describeAnswer(parsed: TelegramResponse | undefined): string | undefined {
	return parsed?.description;
}
