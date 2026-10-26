/**
 * A Telegram message as the door's v1 envelope — the one shape mason accepts, rendered for a person.
 *
 * The envelope is a public contract (`src/server/events.ts` on the mason side): `v` is the version being spoken, `id` is
 * the delivery's permanent identity, `kind` is a label, and `payload` is one string that will be shown to the model
 * inside a fence labelled as untrusted data. Nothing here decides anything — the filter did, in `src/filter.ts`.
 *
 * **The chat id is inside the payload on purpose.** `payload` is a string and the reply needs the id, so the alternative
 * is a second field the door does not have. It reads naturally too: a person's sentence names the room.
 *
 * **The id is `tg-<update_id>`.** An update id is unique per bot and monotonic, so the door's permanent dedupe — one
 * request id, never admitted twice — turns a redelivery after a crash into the same event rather than a second one.
 *
 * **A too-long message is cut here, visibly.** The door refuses a `payload` over 2 000 characters rather than truncating
 * it, and a refusal advances the offset: the event would be lost with nothing but a log line. This sender therefore says
 * what it could not include, which is the honest half of that trade.
 */
import { createHmac } from "node:crypto";

/**
 * The door's cap on a `payload`, kept equal to `PAYLOAD_MAX` in mason's `src/server/events.ts`. Copied rather than
 * imported: this package is built and released on its own, and it must not fail to compile because mason moved a
 * constant.
 */
export const PAYLOAD_MAX = 2_000;

/** What the filter decided a message says, in the pieces the envelope needs. */
export interface ChatEvent {
	readonly updateId: number;
	/** The sender's name, as a person would say it. */
	readonly sender: string;
	readonly username: string | undefined;
	readonly chatId: string;
	readonly chatTitle: string | undefined;
	readonly replyToMessageId: number | undefined;
	/** The message text, with this bot's own `@mention` removed and everything else as it was typed. */
	readonly text: string;
}

/** The v1 envelope, as `src/server/events.ts` reads it. */
export interface EventEnvelope {
	readonly v: 1;
	readonly id: string;
	readonly kind: "chat.message";
	readonly payload: string;
}

/** What stands where a message was too long to forward whole. */
const TRUNCATED = "… [truncated]";

/**
 * The one-line rendering:
 *
 * ```text
 * Ilya (@ilya) in chat -1001234 (Team chat), replying to 8811: ship it?
 * ```
 *
 * Each of the three optional parts disappears cleanly rather than leaving an empty bracket: a private chat has no title,
 * a sender may have no username, and most messages are not replies. The rendering is stable either way — the same
 * message always produces the same string, because it is what the agent reads and the door's dedupe is on the id, not
 * on this.
 */
export function renderPayload(event: ChatEvent): string {
	const handle = event.username === undefined ? "" : ` (@${event.username})`;
	const title = event.chatTitle === undefined ? "" : ` (${event.chatTitle})`;
	const reply = event.replyToMessageId === undefined ? "" : `, replying to ${event.replyToMessageId}`;
	const prefix = `${event.sender}${handle} in chat ${event.chatId}${title}${reply}: `;
	const room = PAYLOAD_MAX - prefix.length;
	if (event.text.length <= room) return `${prefix}${event.text}`;
	if (room <= TRUNCATED.length) return `${prefix}${event.text}`.slice(0, PAYLOAD_MAX);
	return `${prefix}${event.text.slice(0, room - TRUNCATED.length)}${TRUNCATED}`;
}

export function envelopeFor(event: ChatEvent): EventEnvelope {
	return { v: 1, id: `tg-${event.updateId}`, kind: "chat.message", payload: renderPayload(event) };
}

/**
 * The header the door verifies: `sha256=<hex hmac-sha256(secret, the bytes that are sent)>`. The same idiom as
 * `src/server/events.ts`, because the signature is over the raw body before it is parsed — the sender signs exactly the
 * string it posts, and `src/door.ts` posts exactly this string.
 */
export function signBody(secret: string, body: string): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
