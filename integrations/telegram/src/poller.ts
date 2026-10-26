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
 *
 * **A command is an envelope of its own kind, and the message it came from is kept beside it.** Text that starts with a
 * slash is posted as `kind: "command"`, and mason answers whether it acted. `handled: false` means the word means
 * nothing there, so the same update goes to the door again as the message it always was: `/start`, `/foo` and a mistaken
 * `/stopp` reach the agent as text rather than disappearing or failing. `/help` never goes anywhere — it is the relay
 * describing itself, and `src/commands.ts` owns the words.
 *
 * Nothing here waits for a turn. The poller's only queue is the door's own answer, and a command is one more envelope in
 * the batch: `/stop` is posted while the turn it stops is still running, because the door acts on it straight away. The
 * chat's own send queue is not waited on either: an answer posted into a chat that has spent its minute is one warning.
 */
import type { ChatDirectory } from "./chats.ts";
import { commandIn, HELP_TEXT, isHelp } from "./commands.ts";
import type { DoorResult } from "./door.ts";
import { commandEnvelopeFor, envelopeFor, type EventEnvelope, type EventFile } from "./envelope.ts";
import { readMessage, type Attachment, type FilterContext } from "./filter.ts";
import type { SaveOutcome } from "./inbox.ts";
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
	/**
	 * The typing indicator, started when a message becomes a fire. Optional and structural rather than the class itself, so
	 * a poller test needs no timer and the two files stay independent: the poller knows "this chat is being worked on", and
	 * `src/typing.ts` knows how long a chat may look busy.
	 */
	readonly typing?: { start(chatId: string): void };
	/**
	 * Where an attachment is fetched to. Optional and structural for the same reason as the indicator: a test without a
	 * volume says so by leaving it out, and the poller stays the file that knows *that* a message carried a file while
	 * `src/inbox.ts` is the one that knows where it lands.
	 */
	readonly inbox?: {
		save(attachment: Attachment, options: { readonly updateId: number }): Promise<SaveOutcome>;
	};
	/** The clock the downtime log is kept to, in milliseconds. Injected so a test can hold a minute in no time. */
	readonly now?: () => number;
	/**
	 * Posting a command's answer into the chat. Optional and structural, like the indicator: a test without a queue simply
	 * records what was said, and `src/queue.ts` stays the file that knows one chat's minute.
	 */
	readonly reply?: (chatId: string, text: string) => Promise<void>;
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

/** What one update is worth posting, once the filter has answered and the attachment — if any — is on the volume. */
type Prepared =
	| { readonly kind: "skipped"; readonly reason: string }
	/** `/help`: the relay describing itself, answered here and never posted to the door. */
	| { readonly kind: "answered"; readonly chatId: string; readonly text: string }
	| {
			readonly kind: "ready";
			readonly chatId: string;
			/** What is posted first: a command when the message is one, otherwise the message. */
			readonly envelope: EventEnvelope;
			/** The same update as an ordinary message, which a command falls back to when mason does not handle it. */
			readonly message?: EventEnvelope;
	  };

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
			const prepared = await this.#prepare(update);
			if (prepared.kind === "skipped") {
				this.#options.log("info", `skipped update ${update.update_id}: ${prepared.reason}`);
				this.#offset = update.update_id + 1;
				continue;
			}
			if (prepared.kind === "answered") {
				this.#say(prepared.chatId, prepared.text);
				this.#offset = update.update_id + 1;
				continue;
			}
			// The envelope being delivered. A command starts here and is replaced by the message when mason says it did not
			// handle it, so the retry after a door that was down re-posts whichever one is still owed.
			let envelope = prepared.envelope;
			for (;;) {
				const delivery = await this.#options.door.fire(envelope);
				if (delivery.kind !== "unreachable") {
					if (down > 0) {
						this.#options.log(
							"info",
							`the door is answering again after ${down} attempt(s); resuming at update ${update.update_id}`,
						);
						down = 0;
						announcedAt = undefined;
					}
					fired += 1;
					if (delivery.kind === "accepted" && envelope.kind === "command") {
						if (!delivery.answer.handled && prepared.message !== undefined) {
							// The word means nothing there, so the update is the message it always was. Nothing was fired, and the
							// typing indicator is the message's to start.
							envelope = prepared.message;
							continue;
						}
						const reply = delivery.answer.reply;
						if (delivery.answer.handled && reply !== undefined) this.#say(prepared.chatId, reply);
					} else if (delivery.kind === "accepted") {
						// Only an accepted fire is work in progress. A command is not a turn, and dots for one would be the interface
						// lying about what is running.
						this.#options.typing?.start(prepared.chatId);
					}
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

	/**
	 * One update as the door will see it: the filter's verdict, the chat recorded, and — when the message carried a file —
	 * the file fetched and the envelope naming where it landed.
	 *
	 * Prepared once per update rather than once per delivery attempt. A door that is down holds the batch and posts the
	 * same envelope again every half minute, and a 20 MiB photo must not be downloaded again each time it does.
	 */
	async #prepare(update: TelegramUpdate): Promise<Prepared> {
		const reading = readMessage(update, this.#options.filter);
		if ("skip" in reading) return { kind: "skipped", reason: reading.skip };
		// Recorded before the door answers, because the chat is real whether or not this particular message got through:
		// `list_chats` is where the agent may write, not a log of successful deliveries.
		this.#options.chats.add(reading.chat);
		const command = commandIn(reading.event.text);
		if (command !== undefined) {
			if (isHelp(command)) return { kind: "answered", chatId: reading.chat.id, text: HELP_TEXT };
			// The message envelope is built beside the command because a word mason does not handle is still a message, and
			// the file is not fetched for either: a caption that is a command is not a message about a file, and a download
			// spent on `/stop` is spent for nothing.
			return {
				kind: "ready",
				chatId: reading.chat.id,
				envelope: commandEnvelopeFor(reading.event.updateId, command),
				message: envelopeFor(reading.event),
			};
		}
		const file = await this.#save(update.update_id, reading.attachment);
		return {
			kind: "ready",
			chatId: reading.chat.id,
			envelope: envelopeFor(file === undefined ? reading.event : { ...reading.event, file }),
		};
	}

	/**
	 * One line into the chat, through the queue the caller owns. A reply that could not be sent is one warning: the command
	 * itself was answered, and a chat that did not read it must not cost the batch.
	 *
	 * Deliberately not awaited. The queue waits out a chat's twenty-a-minute window (`src/queue.ts`, a minute at its longest),
	 * and this is one loop for every chat — a chat that did not read its answer must not hold the messages behind it, which
	 * is the promise the README makes and the reason a `/stop` typed elsewhere is not stuck behind a `/status` reply. There
	 * is nothing to wait for either way: an answer is posted, or it is logged.
	 */
	#say(chatId: string, text: string): void {
		const reply = this.#options.reply;
		if (reply === undefined) return;
		void reply(chatId, text).catch((error: unknown) => {
			this.#options.log("warn", `could not answer a command in chat ${chatId}: ${describeError(error)}`);
		});
	}

	/**
	 * The file this message carried, on the volume — or nothing, with one line saying why. A file that could not be fetched
	 * is not a message that could not be delivered: the text still says "sent a photo", and a message about a file with no
	 * path is exactly what tells the agent the photo exists and could not be got.
	 */
	async #save(updateId: number, attachment: Attachment | undefined): Promise<EventFile | undefined> {
		const inbox = this.#options.inbox;
		if (attachment === undefined || inbox === undefined) return undefined;
		let failure: string;
		try {
			const outcome = await inbox.save(attachment, { updateId });
			if (outcome.kind === "saved") return outcome.file;
			failure = outcome.reason;
		} catch (error) {
			// `save` answers its expected failures; this is for the ones it did not foresee, and it must not cost a message.
			failure = describeError(error);
		}
		this.#options.log(
			"warn",
			`could not fetch the ${attachment.kind} in update ${updateId} (${failure}); delivering the message without it`,
		);
		return undefined;
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
