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
 * **The offset advances only past an answer.** A refused delivery (`400`, `401`, `404`, `405`, `413`) advances: the
 * door's answer is not this container's to argue with, and stalling on a body it will never accept would block the chat
 * behind it forever. `src/door.ts` logs each one with the body's own error. A door that could not be reached at all —
 * refused connection, timeout, an answer that is not one of those five (`500`, a sidecar's `502`, a proxy's page), a `429`
 * whose wait is longer than this container's own `MAX_THROTTLE_WAIT_MS` (`src/door.ts`) — advances nothing: the batch is
 * held and retried after a bounded backoff, because an update id that was never delivered is never seen again, and
 * nothing downstream could dedupe what never arrived.
 *
 * **A failed long poll is not a failed container.** A proxy reconnecting, a VPN dropping, a `429` from Telegram — each is
 * one logged line and a wait, because the alternative is a restart loop that loses its place less gracefully.
 */
import type { ChatDirectory } from "./chats.ts";
import type { DoorResult } from "./door.ts";
import { envelopeFor, type EventEnvelope } from "./envelope.ts";
import { readMessage, type FilterContext } from "./filter.ts";
import { describeError, formatDuration, type Log } from "./log.ts";
import type { StateFiles } from "./state.ts";
import { TelegramError, type TelegramUpdate } from "./telegram.ts";

/** Telegram holds a long poll open this long when there is nothing to say. */
export const LONG_POLL_SECONDS = 30;
/** How long to wait after a poll that failed for a reason Telegram did not put a number on. */
export const POLL_RETRY_MS = 5_000;
/** The first wait after a delivery the door could not take, doubling from there. */
export const RECONNECT_BACKOFF_MS = 1_000;
/** The ceiling on that wait: a door that comes back is picked up within half a minute of it. */
export const RECONNECT_BACKOFF_MAX_MS = 30_000;
/** How often a door that is still down gets a line. A down door must not fill the log it is being diagnosed from. */
export const RECONNECT_LOG_MS = 60_000;

export interface PollerOptions {
	readonly api: UpdateSource;
	readonly state: StateFiles;
	readonly door: EventSink;
	readonly log: Log;
	readonly chats: ChatDirectory;
	readonly filter: FilterContext;
	readonly pollTimeoutSeconds?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	/** The clock the downtime log is kept to, in milliseconds. Injected so a test can hold a minute in no time. */
	readonly now?: () => number;
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
	/** Envelopes posted to the door and answered. A message the door never took is not counted: the batch is still held. */
	readonly fired: number;
}

/** What one update came to, as the batch loop cares: the door's own answer, or a skip that never reached it. */
type Delivery = { readonly kind: "skipped" } | DoorResult;

export class Poller {
	readonly #options: PollerOptions;
	readonly #timeout: number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #now: () => number;
	/** The next update to ask for. Undefined only until the first poll has decided where "now" is. */
	#offset: number | undefined;

	constructor(options: PollerOptions) {
		this.#options = options;
		this.#timeout = options.pollTimeoutSeconds ?? LONG_POLL_SECONDS;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#now = options.now ?? (() => Date.now());
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
					`poll failed: ${describeError(error)}; retrying in ${formatDuration(waitMs)}`,
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
		if (updates.length === 0) return { read: 0, fired: 0 };
		const summary = await this.#deliverBatch(updates, signal);
		await this.#persist();
		return summary;
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

	/**
	 * One batch, in order, holding on the update the door could not take.
	 *
	 * The offset moves only after a message has an answer, so a door that is down leaves the batch exactly where it was:
	 * the same envelopes are posted again after each wait, and the id makes every one of those one fire. Only the signal
	 * ends the holding, which is how a container asked to stop stops — what it did deliver is persisted, and the update
	 * it did not is where the next batch starts.
	 */
	async #deliverBatch(updates: readonly TelegramUpdate[], signal?: AbortSignal): Promise<PollSummary> {
		let fired = 0;
		let down = 0;
		let announcedAt: number | undefined;
		for (const update of updates) {
			for (;;) {
				const delivery = await this.#deliver(update);
				if (delivery.kind !== "unreachable") {
					if (down > 0) {
						this.#options.log(
							"info",
							`the door is answering again after ${down} attempt(s); resuming at update ${update.update_id}`,
						);
						down = 0;
						announcedAt = undefined;
					}
					if (delivery.kind !== "skipped") fired += 1;
					this.#offset = update.update_id + 1;
					break;
				}
				down += 1;
				const at = this.#now();
				if (announcedAt === undefined || at - announcedAt >= RECONNECT_LOG_MS) {
					announcedAt = at;
					this.#options.log(
						"warn",
						`the door did not take update ${update.update_id} (${delivery.error});` +
							" holding the batch rather than advancing past it",
					);
				}
				const waitMs = reconnectWaitMs(down);
				await this.#sleep(waitMs);
				if (signal?.aborted === true) return { read: updates.length, fired };
			}
		}
		return { read: updates.length, fired };
	}

	async #deliver(update: TelegramUpdate): Promise<Delivery> {
		const reading = readMessage(update, this.#options.filter);
		if ("skip" in reading) {
			this.#options.log("info", `skipped update ${update.update_id}: ${reading.skip}`);
			return { kind: "skipped" };
		}
		// Recorded before the door answers, because the chat is real whether or not this particular message got through:
		// `list_chats` is where the agent may write, not a log of successful deliveries.
		this.#options.chats.add(reading.chat);
		return this.#options.door.fire(envelopeFor(reading.event));
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

/** The wait before a batch the door could not take is tried again: 1 s, doubling, and no longer than half a minute. */
export function reconnectWaitMs(failures: number): number {
	return Math.min(RECONNECT_BACKOFF_MS * 2 ** Math.max(0, failures - 1), RECONNECT_BACKOFF_MAX_MS);
}
