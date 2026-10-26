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
 *
 * **The file clause is the last thing in the payload, and the last thing to give way.** A message that carried a file ends
 * with where it is, so a caption long enough to be cut loses its own words and never the path: the path is the whole
 * reason the attachment reached the agent at all.
 */
import { createHmac } from "node:crypto";
import type { FileKind } from "./telegram.ts";

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
	/** The file the message carried, once `src/inbox.ts` has fetched it. Absent when it carried none, or could not be got. */
	readonly file?: EventFile;
}

/**
 * A file that is on disk, as the payload names it. The path is the point: it is the same string in this container and in
 * the tool machine, because the inbox directory is mounted at one path in both, so `read` opens exactly the bytes this
 * container wrote — and a photo comes back as an image rather than as a path nothing could open.
 */
export interface EventFile {
	/** Where the file is, at the path both containers know it by. */
	readonly path: string;
	/** Its name on the volume: the update id, a hyphen, and the sender's sanitised name. */
	readonly name: string;
	readonly size: number;
	readonly kind: FileKind;
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
 * Ilya (@ilya) in chat -1001234 (Team chat): sent a file: report.pdf, with a file at /home/mason/.mason/agent/workspace/inbox/448860480-report.pdf
 * ```
 *
 * Each of the three optional parts disappears cleanly rather than leaving an empty bracket: a private chat has no title,
 * a sender may have no username, and most messages are not replies. The file clause is the exception — it is appended
 * rather than folded in, because the path is what makes the attachment readable and the text is what can be spared when
 * the two do not both fit. The rendering is stable either way — the same message always produces the same string,
 * because it is what the agent reads and the door's dedupe is on the id, not on this.
 */
export function renderPayload(event: ChatEvent): string {
	const handle = event.username === undefined ? "" : ` (@${event.username})`;
	const title = event.chatTitle === undefined ? "" : ` (${event.chatTitle})`;
	const reply = event.replyToMessageId === undefined ? "" : `, replying to ${event.replyToMessageId}`;
	const prefix = `${event.sender}${handle} in chat ${event.chatId}${title}${reply}: `;
	const file = event.file === undefined ? "" : `, with a file at ${event.file.path}`;
	return `${prefix}${fitText(event.text, PAYLOAD_MAX - prefix.length - file.length)}${file}`;
}

/**
 * The message text cut to the room it has, visibly cut when there is room to say so. `room` is what is left after the
 * prefix and the file clause, and it is the file clause that is never cut: a payload that named no path would be a
 * message about a file the agent cannot open.
 */
function fitText(text: string, room: number): string {
	if (text.length <= room) return text;
	if (room <= 0) return "";
	if (room <= TRUNCATED.length) return text.slice(0, room);
	return `${text.slice(0, room - TRUNCATED.length)}${TRUNCATED}`;
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
