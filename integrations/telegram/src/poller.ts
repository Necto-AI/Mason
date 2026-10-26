/**
 * The trigger face: long polling, one batch at a time, and an offset that survives a crash.
 *
 * **First boot starts from now.** A container that has never read an update calls `getUpdates` once with no offset and
 * a zero timeout, throws the answer away, and persists where the backlog ended. That is the whole of the rule that a
 * restart must not replay yesterday's chat into the agent — and the reverse case, a restart *with* an offset, resumes
 * exactly where the last batch ended, because every accepted message is one fire that the durable log remembers by id.
 *
 * **The offset is written once per batch, not once per message.** A batch of forty messages is one write, and a crash
 * in the middle of one replays at most that batch — harmless, because `tg-<update_id>` is a fire id the door will not
 * admit twice. Writing per message would be a file write per chat line, for a stronger guarantee the dedupe already
 * gives for free.
 *
 * **A refused delivery still advances the offset.** The door's answer is not this container's to argue with: a `400`
 * envelope bug, a `401` wrong secret and a `404` missing integration are all final, and stalling on one would block the
 * chat behind it forever. `src/door.ts` logs each one with the body's own error; this file moves on.
 *
 * **A failed long poll is not a failed container.** A proxy reconnecting, a VPN dropping, a `429` from Telegram — each is
 * one logged line and a wait, because the alternative is a restart loop that loses its place less gracefully.
 */
import type { ChatDirectory } from "./chats.ts";
import type { DoorResult } from "./door.ts";
import { envelopeFor, type EventEnvelope } from "./envelope.ts";
import { readMessage, type FilterContext } from "./filter.ts";
import { describeError, type Log } from "./log.ts";
import type { StateFiles } from "./state.ts";
import { TelegramError, type TelegramUpdate } from "./telegram.ts";

/** Telegram holds a long poll open this long when there is nothing to say. */
export const LONG_POLL_SECONDS = 30;
/** How long to wait after a poll that failed for a reason Telegram did not put a number on. */
export const POLL_RETRY_MS = 5_000;

export interface PollerOptions {
	readonly api: UpdateSource;
	readonly state: StateFiles;
	readonly door: EventSink;
	readonly log: Log;
	readonly chats: ChatDirectory;
	readonly filter: FilterContext;
	readonly pollTimeoutSeconds?: number;
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * What the poller asks of Telegram: one method. Narrow on purpose — a test scripts a list of answers instead of
 * constructing a client, and nothing here can leak the token.
 */
export interface UpdateSource {
	getUpdates(options: {
		readonly offset?: number;
		readonly timeout: number;
		readonly signal?: AbortSignal;
	}): Promise<TelegramUpdate[]>;
}

/** What the poller asks of the door, and all it is allowed to know about it. */
export interface EventSink {
	fire(envelope: EventEnvelope): Promise<DoorResult>;
}

export interface PollSummary {
	/** Updates read in this batch, including the ones the filter skipped. */
	readonly read: number;
	/** Envelopes posted to the door. */
	readonly fired: number;
}

export class Poller {
	readonly #options: PollerOptions;
	readonly #timeout: number;
	readonly #sleep: (ms: number) => Promise<void>;
	/** The next update to ask for. Undefined only until the first poll has decided where "now" is. */
	#offset: number | undefined;

	constructor(options: PollerOptions) {
		this.#options = options;
		this.#timeout = options.pollTimeoutSeconds ?? LONG_POLL_SECONDS;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	/** Poll until the signal aborts. Never resolves on its own: the container is an always-on reader. */
	async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				await this.pollOnce(signal);
			} catch (error) {
				if (signal.aborted) return;
				const waitMs =
					error instanceof TelegramError && error.retryAfter !== undefined
						? error.retryAfter * 1_000
						: POLL_RETRY_MS;
				this.#options.log(
					"warn",
					`poll failed: ${describeError(error)}; retrying in ${Math.round(waitMs / 1_000)}s`,
				);
				await this.#sleep(waitMs);
			}
		}
	}

	/** One batch: the first one decides where this instance starts, the ones after it deliver. */
	async pollOnce(signal?: AbortSignal): Promise<PollSummary> {
		if (this.#offset === undefined) {
			const stored = await this.#options.state.readOffset();
			if (stored === undefined) return this.#startFromNow();
			this.#offset = stored;
			this.#options.log("info", `resuming from update ${stored}`);
		}
		const updates = await this.#options.api.getUpdates({
			offset: this.#offset,
			timeout: this.#timeout,
			...(signal === undefined ? {} : { signal }),
		});
		let fired = 0;
		for (const update of updates) {
			// Advance before delivering: an event that is already understood must not be read twice if the door is
			// slow, and the id makes a re-read harmless anyway.
			this.#offset = update.update_id + 1;
			if (await this.#deliver(update)) fired += 1;
		}
		if (updates.length > 0) await this.#persist();
		return { read: updates.length, fired };
	}

	/** The offset this instance will ask for next; exposed so the boot log can say where it started. */
	get offset(): number | undefined {
		return this.#offset;
	}

	/**
	 * First boot: read the backlog without an offset, discard it, and remember where it ended. `timeout: 0` because
	 * there is nothing to wait for — the answer is whatever has piled up, and none of it is news.
	 */
	async #startFromNow(): Promise<PollSummary> {
		const backlog = await this.#options.api.getUpdates({ timeout: 0 });
		const last = backlog.at(-1);
		this.#offset = last === undefined ? 0 : last.update_id + 1;
		await this.#persist();
		this.#options.log(
			"info",
			`first boot: discarded ${backlog.length} queued update(s) and will read from update ${this.#offset}`,
		);
		return { read: backlog.length, fired: 0 };
	}

	async #deliver(update: TelegramUpdate): Promise<boolean> {
		const reading = readMessage(update, this.#options.filter);
		if ("skip" in reading) {
			this.#options.log("info", `skipped update ${update.update_id}: ${reading.skip}`);
			return false;
		}
		// Recorded before the door answers, because the chat is real whether or not this particular message got through:
		// `list_chats` is where the agent may write, not a log of successful deliveries.
		this.#options.chats.add(reading.chat);
		await this.#options.door.fire(envelopeFor(reading.event));
		return true;
	}

	/** The offset and, when it grew, the chat list — in that order, so a crash between the two loses a chat, not a place. */
	async #persist(): Promise<void> {
		if (this.#offset !== undefined) await this.#options.state.writeOffset(this.#offset);
		if (this.#options.chats.dirty) {
			await this.#options.state.writeChats(this.#options.chats.list());
			this.#options.chats.clean();
		}
	}
}
