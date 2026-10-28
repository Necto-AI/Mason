/**
 * The trigger face's one delivery: sign the envelope, post it to the door, and never advance past something that could
 * still be delivered.
 *
 * mason's door answers `202` and nothing else is a delivery (`src/server/events.ts`). The four answers below it are each
 * a different thing, and this file keeps them apart:
 *
 * - **A refusal** — `400` a bad envelope, `401` a bad signature, `404` a path that names no integration, `405` a method
 *   that is not POST, `413` a body over the door's cap — is final, and only those five are. The offset advances past it,
 *   because a message the door will never accept must not be retried forever: it would block the chat behind it, and
 *   every retry would make the same refusal again. It is logged with the body's own `error` rather than swallowed, so the
 *   operator can fix the config and know what was lost — and the sentence travels with the refusal, because a refused
 *   command still has the message it came from: `src/poller.ts` falls back to that and tells the chat why.
 * - **`429` over the budget is a wait, not a verdict.** The door answers six deliveries a minute and says in
 *   `retry-after` when it has room; the same bytes are posted again after exactly that, which is one fire either way
 *   because the envelope's id never changes. One line names the wait — not one a second — and a wait longer than
 *   `MAX_THROTTLE_WAIT_MS` is not sat through: the delivery is reported as unreachable so the batch is retried rather
 *   than advanced past. That loop ends when the door takes the envelope, which its own number is the promise of: the
 *   delivery that was refused for budget was never counted against it.
 * - **A network failure** is retried three times with exponential backoff. A container that restarts with the mason
 *   container is the ordinary case, and the second attempt usually lands after the other end has bound its port. Past
 *   that it is reported as unreachable and `src/poller.ts` holds the batch, because an id that was never delivered is
 *   never seen again.
 * - **Any other status** — the door's own `500`, a sidecar's `502`, a proxy's `503` with an HTML page — is not a verdict
 *   at all: nothing said the same bytes will get the same answer, and a door that failed to fire the hook did not refuse
 *   the event. It is reported as unreachable exactly like a network failure, so `src/poller.ts` holds the batch and
 *   tries the same bytes again rather than losing a message to a restart on the mason side.
 *
 * **An accepted answer is read, not assumed.** A message is `202` with a submission id, and a command is `200` with
 * `{ handled, reply }`, so the body is parsed on every accepted answer and reduced to the two things a relay acts on: was
 * it handled, and what does the chat say. A body that is not JSON is an accepted delivery of something this relay does
 * not ask about, which is exactly what a message's answer looks like from here.
 *
 * The signature is over the exact bytes posted: `JSON.stringify` once, then the same string signed and sent. Re-encoding
 * on the way out would sign something the door never received, which is precisely the failure the header exists to
 * catch.
 */
import { signBody, type EventEnvelope } from "./envelope.ts";
import { describeError, formatDuration, type Log } from "./log.ts";
import type { Fetch, FetchResponse } from "./telegram.ts";

/** Three retries after the first try, and 250 ms doubling: a container pair restarting together is the case this is for. */
export const RETRY_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 250;
/**
 * The longest `retry-after` this will sit through: this container's own cap, not a budget the door has. The door's window
 * is a minute, so a real answer is far below it; this is the cap that keeps a wrong one — a proxy quoting an hour — from
 * parking the poller on a single message.
 */
export const MAX_THROTTLE_WAIT_MS = 5 * 60_000;
/**
 * The statuses that mean the same thing on every attempt, and the only ones after which the offset may advance: a bad
 * envelope, a bad signature, a path that names no integration, a method that is not POST, a body over the cap.
 */
export const FINAL_REFUSAL_STATUSES: readonly number[] = [400, 401, 404, 405, 413];

export type DoorResult =
	| { readonly kind: "accepted"; readonly answer: DoorAnswer }
	/**
	 * `reason` is the door's own sentence about the refusal, when its body carried one. It is not decoration: a refused
	 * *command* still has the message it came from, so the relay falls back to that and posts this sentence into the chat,
	 * which is the only way the person learns why the word did not happen.
	 */
	| { readonly kind: "refused"; readonly status: number; readonly reason?: string }
	| { readonly kind: "unreachable"; readonly error: string };

/**
 * What an accepted answer carried: whether mason acted on the envelope, and the one line it wants posted into the chat.
 * A message answers a submission id and neither of these, so here it is `handled: false` with no reply.
 */
export interface DoorAnswer {
	readonly handled: boolean;
	readonly reply: string | undefined;
}

/** What one POST came to. `throttled` is a `429` whose wait this will not honour, and it is not final. */
type PostResult =
	| { readonly kind: "accepted"; readonly answer: DoorAnswer }
	| { readonly kind: "refused"; readonly status: number; readonly reason?: string }
	| { readonly kind: "throttled"; readonly waitMs: number | undefined }
	| { readonly kind: "failed"; readonly error: string };

export interface EventDoorOptions {
	readonly url: string;
	readonly secret: string;
	readonly fetch: Fetch;
	readonly log: Log;
	/** The integration's name, as the operator wrote it in `integrations.json` on the mason side. */
	readonly integration: string;
	readonly retries?: number;
	readonly backoffMs?: number;
	readonly maxWaitMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
}

export class EventDoor {
	readonly #options: EventDoorOptions;
	readonly #retries: number;
	readonly #backoffMs: number;
	readonly #maxWaitMs: number;
	readonly #sleep: (ms: number) => Promise<void>;

	constructor(options: EventDoorOptions) {
		this.#options = options;
		this.#retries = options.retries ?? RETRY_ATTEMPTS;
		this.#backoffMs = options.backoffMs ?? RETRY_BACKOFF_MS;
		this.#maxWaitMs = options.maxWaitMs ?? MAX_THROTTLE_WAIT_MS;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	async fire(envelope: EventEnvelope): Promise<DoorResult> {
		const body = JSON.stringify(envelope);
		let failure = "";
		for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
			if (attempt > 0) await this.#sleep(this.#backoffMs * 2 ** (attempt - 1));
			const outcome = await this.#post(body, envelope);
			if (outcome.kind === "accepted") return { kind: "accepted", answer: outcome.answer };
			if (outcome.kind === "refused") return outcome;
			if (outcome.kind === "throttled") {
				// Not final, and not a network failure either: the message is good and the door is full. `src/poller.ts`
				// holds the batch, which is the same message tried again later.
				const asked =
					outcome.waitMs === undefined ? "no wait it could read" : `a ${formatDuration(outcome.waitMs)} wait`;
				this.#options.log(
					"error",
					`${this.#options.integration}: the door is over its budget and named ${asked} for ${envelope.id};` +
						" holding it rather than advancing past it",
				);
				return { kind: "unreachable", error: `the door answered 429 with ${asked}` };
			}
			failure = outcome.error;
		}
		this.#options.log(
			"error",
			`${this.#options.integration}: could not deliver ${envelope.id} after ${this.#retries + 1} attempts ` +
				`(${failure}); the batch will be retried`,
		);
		return { kind: "unreachable", error: failure };
	}

	/**
	 * One delivery's worth of POSTs: the first, then one more after each `429` whose wait it will honour. The body is
	 * signed and sent as the same string every time, so a redelivery is byte-identical to the delivery it repeats.
	 */
	async #post(body: string, envelope: EventEnvelope): Promise<PostResult> {
		for (;;) {
			let answer: FetchResponse;
			try {
				answer = await this.#options.fetch(this.#options.url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-mason-signature": signBody(this.#options.secret, body),
					},
					body,
				});
			} catch (error) {
				return { kind: "failed", error: describeError(error) };
			}
			if (answer.ok) {
				const text = await answer.text().catch(() => "");
				this.#options.log(
					"info",
					`delivered ${envelope.id} (${envelope.kind}) to the ${this.#options.integration} door as ${answer.status}`,
				);
				return { kind: "accepted", answer: acceptedAnswer(text) };
			}
			const text = await answer.text().catch(() => "");
			if (answer.status !== 429) {
				const reason = answerReason(text);
				const said = `${answer.status}${reason === undefined ? "" : `: ${reason}`}`;
				if (!FINAL_REFUSAL_STATUSES.includes(answer.status)) {
					// Not a refusal: a `500` is the door failing to fire the hook, a `502` is a sidecar that never reached it.
					// Neither says the same bytes will get the same answer, so this is the network-failure path, not the end.
					return { kind: "failed", error: `the door answered ${said}` };
				}
				this.#options.log(
					"warn",
					`${this.#options.integration}: the door refused ${envelope.id} with ${said}; the offset advances past it`,
				);
				return { kind: "refused", status: answer.status, ...(reason === undefined ? {} : { reason }) };
			}
			const waitMs = retryAfterMs(answer, text);
			if (waitMs === undefined || waitMs > this.#maxWaitMs) return { kind: "throttled", waitMs };
			this.#options.log(
				"warn",
				`${this.#options.integration}: the door is over its budget; waiting ${formatDuration(waitMs)}` +
					` and posting ${envelope.id} again`,
			);
			await this.#sleep(waitMs);
		}
	}
}

/**
 * The body as a JSON object, or `undefined` when it is not one — a proxy's HTML page, an empty body. Every field this file
 * reads out of an answer goes through here, so "is this JSON at all" is decided in one place.
 */
function jsonObject(text: string): Record<string, unknown> | undefined {
	if (text === "") return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** What a `200` said, as far as a relay acts on it: `{ handled: true, reply: "stopped" }` for a command mason ran. */
function acceptedAnswer(text: string): DoorAnswer {
	const body = jsonObject(text);
	const reply = body?.reply;
	return {
		handled: body?.handled === true,
		// A reply that is not a non-empty string is no reply: an empty message is one Telegram refuses, and a line the chat
		// reads is the whole reason the answer carries one.
		reply: typeof reply === "string" && reply !== "" ? reply : undefined,
	};
}

/** The door's own sentence about an answer: `{ "error": "…" }`, which is what its `400` and `500` bodies carry. */
function answerReason(text: string): string | undefined {
	const error = jsonObject(text)?.error;
	if (typeof error === "string" && error !== "") return error;
	// A proxy's error page is not JSON, and its first line is still the best sentence available.
	const line = text.split("\n", 1)[0]?.trim();
	return line === "" ? undefined : line;
}

/**
 * How long the door asked for, in milliseconds: the `retry-after` header (seconds) first, then mason's own
 * `retryAfterSeconds` in the body, which it sends beside the header. `undefined` when the answer named no wait this can
 * use — a `429` without a number is not an instruction.
 */
function retryAfterMs(answer: FetchResponse, text: string): number | undefined {
	const header = answer.headers?.get("retry-after")?.trim() ?? "";
	const seconds = header === "" ? bodyRetryAfter(text) : Number(header);
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
	return Math.round(seconds * 1_000);
}

/** mason's `429` body: `{ "error": "too many deliveries", "retryAfterSeconds": 42 }`. */
function bodyRetryAfter(text: string): number | undefined {
	const seconds = jsonObject(text)?.retryAfterSeconds;
	return typeof seconds === "number" ? seconds : undefined;
}
