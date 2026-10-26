/**
 * The trigger face's one delivery: sign the envelope, post it to the door, and never retry something the door refused.
 *
 * mason's door answers `202` and nothing else is a delivery (`src/server/events.ts`). The three answers below it are
 * each a different thing, and this file keeps them apart:
 *
 * - **A refusal** — `400` a bad envelope, `401` a bad signature, `404` a path that names no integration, `429` over the
 *   budget — is final. The offset advances past it, because a message the door will never accept must not be retried
 *   forever: it would block the chat behind it, and every retry would make the same refusal again. It is logged with the
 *   body's own `error` rather than swallowed, so the operator can fix the config and know what was lost.
 * - **A network failure** is retried three times with exponential backoff. A container that restarts with the mason
 *   container is the ordinary case, and the second attempt usually lands after the other end has bound its port.
 * - **Anything else** — a proxy's HTML page, a `500` — is logged as one line and treated as a refusal: the door is not
 *   going to be made to work by this container, and the offset must not stall on it.
 *
 * The signature is over the exact bytes posted: `JSON.stringify` once, then the same string signed and sent. Re-encoding
 * on the way out would sign something the door never received, which is precisely the failure the header exists to
 * catch.
 */
import { signBody, type EventEnvelope } from "./envelope.ts";
import { describeError, type Log } from "./log.ts";
import type { Fetch, FetchResponse } from "./telegram.ts";

/** Three retries after the first try, and 250 ms doubling: a container pair restarting together is the case this is for. */
export const RETRY_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 250;
export type DoorResult =
	| { readonly kind: "accepted" }
	| { readonly kind: "refused"; readonly status: number }
	| { readonly kind: "unreachable"; readonly error: string };

export interface EventDoorOptions {
	readonly url: string;
	readonly secret: string;
	readonly fetch: Fetch;
	readonly log: Log;
	/** The integration's name, as the operator wrote it in `integrations.json` on the mason side. */
	readonly integration: string;
	readonly retries?: number;
	readonly backoffMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
}

export class EventDoor {
	readonly #options: EventDoorOptions;
	readonly #retries: number;
	readonly #backoffMs: number;
	readonly #sleep: (ms: number) => Promise<void>;

	constructor(options: EventDoorOptions) {
		this.#options = options;
		this.#retries = options.retries ?? RETRY_ATTEMPTS;
		this.#backoffMs = options.backoffMs ?? RETRY_BACKOFF_MS;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	async fire(envelope: EventEnvelope): Promise<DoorResult> {
		const body = JSON.stringify(envelope);
		let failure = "";
		for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
			if (attempt > 0) await this.#sleep(this.#backoffMs * 2 ** (attempt - 1));
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
				failure = describeError(error);
				continue;
			}
			if (answer.ok) {
				this.#options.log(
					"info",
					`delivered ${envelope.id} (${envelope.kind}) to the ${this.#options.integration} door as ${answer.status}`,
				);
				return { kind: "accepted" };
			}
			const reason = await refusalReason(answer);
			this.#options.log(
				"warn",
				`${this.#options.integration}: the door refused ${envelope.id} with ${answer.status}` +
					`${reason === undefined ? "" : `: ${reason}`}; the offset advances past it`,
			);
			return { kind: "refused", status: answer.status };
		}
		this.#options.log(
			"error",
			`${this.#options.integration}: could not deliver ${envelope.id} after ${this.#retries + 1} attempts ` +
				`(${failure}); the offset advances past it`,
		);
		return { kind: "unreachable", error: failure };
	}
}

/** The door's own sentence about a refusal: `{ "error": "…" }`, which is what its `400` answers carry. */
async function refusalReason(answer: FetchResponse): Promise<string | undefined> {
	const text = await answer.text().catch(() => "");
	if (text === "") return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed === "object" && parsed !== null) {
			const error = (parsed as { error?: unknown }).error;
			if (typeof error === "string" && error !== "") return error;
		}
	} catch {
		// A proxy's error page is not JSON, and its first line is still the best sentence available.
	}
	const line = text.split("\n", 1)[0]?.trim();
	return line === "" ? undefined : line;
}
