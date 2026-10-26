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
 *
 * **A transcript is labelled, fenced, and never mistaken for the sender's typing.** `src/asr.ts` hears a voice note, and
 * what it heard arrives between a line that names it and a line that closes it, so neither the model nor a reader can
 * read the words as something the person wrote. It is fitted like the rest of the message — a long transcript is cut and
 * says so — and it sits before the file clause, because the path is the one thing that must survive any cut.
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
	/**
	 * What a transcription service heard in that file, whether it heard nothing, or why it could not be asked. Absent when
	 * the message carried no speech, when no service is configured, or when the file never landed — the three cases where
	 * nothing was attempted.
	 */
	readonly transcript?: Transcript;
}

/**
 * A voice note's words, as the payload states them.
 *
 * The three states are three different things and the payload says each one: `text` is what the service heard, `silent`
 * is a clip that was transcribed and had no words in it, and `unavailable` is a service was asked and could not answer.
 * Neither of the last two is the absence of the field — that is "nobody asked" — and a person who sent a voice note
 * deserves to know which of them it was.
 */
export type Transcript =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "silent" }
	| { readonly kind: "unavailable" };

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
	/** `chat.message` is a person's words; `command` is the same person asking mason to do one of a closed set of things. */
	readonly kind: "chat.message" | "command";
	readonly payload: string;
}

/** What stands where a message was too long to forward whole. */
const TRUNCATED = "… [truncated]";

/**
 * The line a transcript starts under, and the one it ends on. Both are English prose rather than punctuation, because the
 * reader is a model and a person: `"""` or a backtick fence can be forged by the words inside it, and a marker line that
 * says what it is has nothing to guess at. The block is closed explicitly so a long transcript cannot look like the
 * sender's own words running on past the label.
 */
const TRANSCRIPT_OPEN = "[transcript of the voice message, spoken and not typed by the sender]";
const TRANSCRIPT_CLOSE = "[end of transcript]";

/** What the payload says when a service was asked and could not answer: one parenthetical on the sentence, never silence. */
const TRANSCRIPT_UNAVAILABLE = " (the voice message could not be transcribed)";

/**
 * And what it says when the service did answer and there were no words in the clip. Said out loud rather than rendered as
 * an empty block, because an empty block reads as a failure: a cough, a room with nobody talking and a note recorded by
 * accident are all messages somebody sent, and the service heard exactly that.
 */
const TRANSCRIPT_SILENT = " (the voice message was transcribed and says nothing)";

/**
 * The rendering:
 *
 * ```text
 * Ilya (@ilya) in chat -1001234 (Team chat), replying to 8811: ship it?
 * Ilya (@ilya) in chat -1001234 (Team chat): sent a file: report.pdf, with a file at /home/mason/.mason/agent/workspace/inbox/448860480-report.pdf
 * Ilya (@ilya) in chat -1001234 (Team chat): sent a voice note
 * [transcript of the voice message, spoken and not typed by the sender]
 * can you check the pricing sheet before Thursday
 * [end of transcript], with a file at /home/mason/.mason/agent/workspace/inbox/8811-voice-u1.ogg
 * ```
 *
 * Each of the three optional parts disappears cleanly rather than leaving an empty bracket: a private chat has no title,
 * a sender may have no username, and most messages are not replies. The file clause is the exception — it is appended
 * rather than folded in, because the path is what makes the attachment readable and the text is what can be spared when
 * the two do not both fit. A transcript is the other exception: it starts a line of its own, so the block is unmistakably
 * not the sentence the sender wrote. The rendering is stable either way — the same message always produces the same
 * string, because it is what the agent reads and the door's dedupe is on the id, not on this.
 */
export function renderPayload(event: ChatEvent): string {
	const handle = event.username === undefined ? "" : ` (@${event.username})`;
	const title = event.chatTitle === undefined ? "" : ` (${event.chatTitle})`;
	const reply = event.replyToMessageId === undefined ? "" : `, replying to ${event.replyToMessageId}`;
	const prefix = `${event.sender}${handle} in chat ${event.chatId}${title}${reply}: `;
	const file = event.file === undefined ? "" : `, with a file at ${event.file.path}`;
	// The transcript joins the text before the one fitting, so the cap holds without a second budget and a cut transcript
	// is as visibly cut as a cut caption. It comes before the file clause for the same reason the caption does: the path is
	// what must survive, and a block appended after it could not be shortened without shortening the path too.
	const body = `${event.text}${transcriptBlock(event.transcript)}`;
	// The clause is never cut and the text always is, which works while the clause itself fits. A path long enough to leave
	// no room at all (a misconfigured `TELEGRAM_INBOX`) would otherwise produce a payload over the cap that the door
	// refuses, and a refused delivery is a message nobody reads: the prefix gives way instead, from the left.
	// When even that does not fit, the path is dropped rather than cut: a truncated path is one the agent would try to
	// open and not find, which is worse than a payload that says a file exists and cannot be named. `TELEGRAM_INBOX` is
	// checked at startup for this, so reaching it is a bug rather than a setting.
	const named = PAYLOAD_MAX - prefix.length - file.length >= 0 ? file : ", with a file this payload has no room to name";
	return `${prefix}${fitText(body, PAYLOAD_MAX - prefix.length - named.length)}${named}`;
}

/**
 * The transcript as it sits in the payload: a labelled block after the sentence, between its own opening and closing
 * lines, or the parenthetical that says the words are missing — or that there were none to miss.
 *
 * The markers inside the transcript are defused the way mason's own fence defuses its own (`src/server/untrusted.ts`): a
 * transcript line that reads as the close of the block could otherwise end it early and continue in the sender's voice,
 * which is the one thing the label is here to prevent.
 */
function transcriptBlock(transcript: Transcript | undefined): string {
	if (transcript === undefined) return "";
	if (transcript.kind === "unavailable") return TRANSCRIPT_UNAVAILABLE;
	if (transcript.kind === "silent") return TRANSCRIPT_SILENT;
	const defused = transcript.text
		.split("\n")
		.map((line) =>
			line.trim() === TRANSCRIPT_OPEN || line.trim() === TRANSCRIPT_CLOSE
				? `(marker in transcript) ${line.trim()}`
				: line,
		)
		.join("\n");
	return `\n${TRANSCRIPT_OPEN}\n${defused}\n${TRANSCRIPT_CLOSE}`;
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
 * A command, as the door's second kind: the text after the slash, and the same `tg-<update_id>` id its message would
 * have carried.
 *
 * The id is shared with the message because it is the same update: a redelivery is one envelope either way, and the
 * door's dedupe answers a command it has already run instead of running it twice. What the command means is mason's
 * business — the relay only knows where the slash was, and what to do with an answer that says it was not handled
 * (`src/poller.ts` sends the message it kept beside this envelope).
 */
export function commandEnvelopeFor(updateId: number, command: string): EventEnvelope {
	return { v: 1, id: `tg-${updateId}`, kind: "command", payload: command };
}

/**
 * The header the door verifies: `sha256=<hex hmac-sha256(secret, the bytes that are sent)>`. The same idiom as
 * `src/server/events.ts`, because the signature is over the raw body before it is parsed — the sender signs exactly the
 * string it posts, and `src/door.ts` posts exactly this string.
 */
export function signBody(secret: string, body: string): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
