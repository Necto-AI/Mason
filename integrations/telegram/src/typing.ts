/**
 * The typing indicator: the only sign of life a chat has while a turn is running.
 *
 * A chat is where the agent spends minutes and says nothing. ADR-0004 puts it plainly — there is no streaming, a message
 * arrives whole, and a long turn is silence until it is not. `sendChatAction` is Telegram's answer to that silence: three
 * dots and "typing…" in the header, cleared by the chat after about five seconds, or as soon as a message lands. So it
 * is not a state this file sets once; it is a heartbeat, re-sent while the turn lasts.
 *
 * **Started by an accepted delivery, stopped by a send.** The poller knows when a message became a fire, which is when
 * the agent started working on it, and the tools face knows when an answer left (`mcp__telegram__send_message`), which
 * is when the dots have done their job — the message itself replaces them. Nothing else in the container knows either
 * edge, and no signal from mason is needed: the two things that matter both happen here.
 *
 * **Bounded, because the stop is a heuristic.** A turn can end without a send (the agent decided the message needed
 * nothing, or the model failed, or an approval is waiting on a person). The heartbeat therefore expires on its own after
 * `maxMs`, and a chat that goes quiet gets its header back rather than dots that never stop. A failed ping is logged
 * once per chat and then swallowed: the indicator is a courtesy, and a proxy hiccup must not become a log flood or a
 * crash in the poll loop.
 */
import { describeError, type Log } from "./log.ts";

/** Telegram clears a typing indicator after about five seconds, so this is the refresh that keeps it lit. */
export const TYPING_REFRESH_MS = 4_000;
/** The longest one turn keeps the dots up. Long enough for a slow model turn, short enough to be a lie for minutes. */
export const TYPING_MAX_MS = 180_000;

/** A timer, injected so a test can drive the heartbeat without waiting for it. */
export interface TypingTimers {
	readonly setInterval: (callback: () => void, ms: number) => unknown;
	readonly clearInterval: (handle: unknown) => void;
}

export interface TypingOptions {
	/** One `sendChatAction`, for one chat. Rejections are this file's to absorb, not the caller's. */
	readonly ping: (chatId: string) => Promise<void>;
	readonly log: Log;
	readonly refreshMs?: number;
	readonly maxMs?: number;
	readonly now?: () => number;
	readonly timers?: TypingTimers;
}

export class TypingIndicator {
	readonly #options: Required<Pick<TypingOptions, "ping" | "log" | "refreshMs" | "maxMs" | "now" | "timers">>;
	/** The chats that are typing, and when this heartbeat gives up on each. */
	readonly #deadlines = new Map<string, number>();
	/** Chats whose ping failed since they last started: one line each, rather than one line every four seconds. */
	readonly #warned = new Set<string>();
	#handle: unknown;

	constructor(options: TypingOptions) {
		this.#options = {
			refreshMs: TYPING_REFRESH_MS,
			maxMs: TYPING_MAX_MS,
			now: () => Date.now(),
			timers: {
				setInterval: (callback, ms) => setInterval(callback, ms),
				clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
			},
			...options,
		};
	}

	/** The chats currently typing. Read by a test, and by nothing else. */
	get typing(): readonly string[] {
		return [...this.#deadlines.keys()];
	}

	/** A fire was accepted: this chat is being worked on, so start the dots and keep them going for `maxMs`. */
	start(chatId: string): void {
		this.#deadlines.set(chatId, this.#options.now() + this.#options.maxMs);
		this.#warned.delete(chatId);
		this.#ensureRunning();
		void this.#ping(chatId);
	}

	/** An answer left, or the chat is gone: stop the dots. Clearing a chat that is not typing is not an error. */
	stop(chatId: string): void {
		if (!this.#deadlines.delete(chatId)) return;
		this.#warned.delete(chatId);
		this.#stopWhenIdle();
	}

	/** Everything at once, for a container asked to stop. */
	stopAll(): void {
		this.#deadlines.clear();
		this.#warned.clear();
		this.#stopWhenIdle();
	}

	#ensureRunning(): void {
		if (this.#handle !== undefined) return;
		this.#handle = this.#options.timers.setInterval(() => this.#sweep(), this.#options.refreshMs);
	}

	#stopWhenIdle(): void {
		if (this.#deadlines.size > 0 || this.#handle === undefined) return;
		this.#options.timers.clearInterval(this.#handle);
		this.#handle = undefined;
	}

	/**
	 * One heartbeat: ping every chat that is still inside its window, and drop the ones that are not. The dropped chat is
	 * not told anything — there is nothing to send that would make the dots go away, and Telegram clears them by itself.
	 */
	#sweep(): void {
		const at = this.#options.now();
		for (const [chatId, deadline] of [...this.#deadlines]) {
			if (at >= deadline) {
				this.#deadlines.delete(chatId);
				this.#warned.delete(chatId);
				continue;
			}
			void this.#ping(chatId);
		}
		this.#stopWhenIdle();
	}

	async #ping(chatId: string): Promise<void> {
		try {
			await this.#options.ping(chatId);
		} catch (error) {
			if (this.#warned.has(chatId)) return;
			this.#warned.add(chatId);
			this.#options.log("warn", `could not show a typing indicator in chat ${chatId}: ${describeError(error)}`);
		}
	}
}
