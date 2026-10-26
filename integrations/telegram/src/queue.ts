/**
 * Outbound sends, one chat at a time, twenty a minute, and a 429 honoured rather than fought.
 *
 * Telegram's limit for a bot in a group is twenty messages a minute, and it does not queue for you: the answer is a
 * refusal with a number in it. Two things follow, and this file is both.
 *
 * **A per-chat window.** A chat's sends are serialised — the replies in one conversation read in the order they were
 * sent — and each waits until the window has room. Two chats do not wait for each other, because the limit is per chat
 * and one busy group must not silence a private message.
 *
 * **`retry_after` is an instruction.** A 429 carries how many seconds to wait, and the answer is to wait exactly that
 * long and send again; retrying sooner is what turns a short throttle into a longer one. The retries are bounded and a
 * wait longer than `maxWaitMs` ends the call instead of holding a tool call open for an hour — an agent that is told
 * "try later" can tell the reader, and one that hangs cannot.
 *
 * Time is injected (`now`, `sleep`) so a test can hold a whole minute of throttling in no time at all.
 */
import { describeError, redact } from "./log.ts";
import type { SendOutcome } from "./telegram.ts";

/** Telegram's own limit for a bot in a group, per minute. Not a preference. */
export const DEFAULT_LIMIT = 20;
export const DEFAULT_WINDOW_MS = 60_000;
/** How many times one send is tried again after a 429, before the caller is told. */
export const DEFAULT_RETRIES = 3;
/** The longest single wait this will honour. Beyond this the call fails rather than blocks. */
export const DEFAULT_MAX_WAIT_MS = 60_000;

export interface SendQueueOptions {
	readonly limit?: number;
	readonly windowMs?: number;
	readonly retries?: number;
	readonly maxWaitMs?: number;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	/**
	 * What must never appear in a failure the model reads: the bot token, which a thrown client error can quote out of the
	 * URL it was called at. The queue is the last place a `send_message` error passes through, so it is the last place
	 * that can redact one.
	 */
	readonly secrets?: readonly string[];
	/** Called before a wait, so the log says why a reply is late. */
	readonly onWait?: (chatId: string, waitMs: number, reason: "rate" | "throttled") => void;
}

export class SendQueue {
	readonly #limit: number;
	readonly #windowMs: number;
	readonly #retries: number;
	readonly #maxWaitMs: number;
	readonly #now: () => number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #secrets: readonly string[];
	readonly #onWait: SendQueueOptions["onWait"];
	/** Successful send times per chat, pruned to the window as it moves. */
	readonly #sent = new Map<string, number[]>();
	/** The tail of each chat's chain. One entry per chat, and a bot is in a bounded number of chats. */
	readonly #tails = new Map<string, Promise<unknown>>();

	constructor(options: SendQueueOptions = {}) {
		this.#limit = options.limit ?? DEFAULT_LIMIT;
		this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
		this.#retries = options.retries ?? DEFAULT_RETRIES;
		this.#maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
		this.#now = options.now ?? (() => Date.now());
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#secrets = options.secrets ?? [];
		this.#onWait = options.onWait;
	}

	/** Run one attempt when this chat's turn comes, and settle with what Telegram made of it. */
	enqueue(chatId: string, attempt: () => Promise<SendOutcome>): Promise<SendOutcome> {
		const previous = this.#tails.get(chatId) ?? Promise.resolve();
		const run = previous.then(
			() => this.#run(chatId, attempt),
			() => this.#run(chatId, attempt),
		);
		// The tail never rejects: a failed send is one caller's outcome, not a broken queue for the chat.
		this.#tails.set(chatId, run.catch(() => undefined));
		return run;
	}

	async #run(chatId: string, attempt: () => Promise<SendOutcome>): Promise<SendOutcome> {
		for (let tried = 0; ; tried += 1) {
			await this.#waitForSlot(chatId);
			let outcome: SendOutcome;
			try {
				outcome = await attempt();
			} catch (error) {
				// The same redactor the log uses: this error becomes a tool result the model reads, and a token in the
				// transcript is a token in the log, the UI and every backup.
				return { kind: "failed", error: redact(describeError(error), this.#secrets) };
			}
			if (outcome.kind === "sent") {
				this.#record(chatId);
				return outcome;
			}
			if (outcome.kind !== "throttled") return outcome;
			const waitMs = outcome.retryAfter * 1_000;
			if (tried >= this.#retries) {
				return {
					kind: "failed",
					error: `Telegram is throttling this chat (${outcome.retryAfter} s) after ${this.#retries} retries`,
				};
			}
			if (waitMs > this.#maxWaitMs) {
				return {
					kind: "failed",
					error: `Telegram asked for a ${outcome.retryAfter} s wait on this chat; this call gives up rather than hold the tool call open`,
				};
			}
			this.#onWait?.(chatId, waitMs, "throttled");
			await this.#sleep(waitMs);
		}
	}

	/** Sleep until this chat has room in its window; with room already, this is a no-op. */
	async #waitForSlot(chatId: string): Promise<void> {
		for (;;) {
			const now = this.#now();
			const recent = (this.#sent.get(chatId) ?? []).filter((at) => now - at < this.#windowMs);
			if (recent.length < this.#limit) {
				this.#sent.set(chatId, recent);
				return;
			}
			const oldest = recent[0] ?? now;
			const waitMs = Math.max(1, oldest + this.#windowMs - now);
			this.#onWait?.(chatId, waitMs, "rate");
			await this.#sleep(waitMs);
		}
	}

	#record(chatId: string): void {
		const times = this.#sent.get(chatId) ?? [];
		times.push(this.#now());
		this.#sent.set(chatId, times);
	}
}
