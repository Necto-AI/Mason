/**
 * Whether an update becomes an event, and what it says if it does.
 *
 * This is the gate the issue is really about: the bot may be in chats nobody chose, a chat may contain other bots, and
 * Telegram will happily send an edit. Every one of those is dropped here, before anything is signed or posted, because an
 * event that reaches the door has already been worth a model turn — the door has no second filter and no way to ask.
 *
 * Four decisions worth naming:
 *
 * - **A chat we did not choose must not even become a chat.** The allowlist is checked before anything else is read, and
 *   a chat that fails it is not added to `list_chats` either: the list is the agent's map of where it may write, and a
 *   chat it may not write to does not belong on it.
 * - **Commands are delivered.** `/start`, `/help` and a `/command@this_bot` with the bot's own mention stripped are
 *   ordinary messages: a person typed them, in a chat we chose, and deciding here which commands mean something would be
 *   this container guessing at what the agent should hear. The model sees the text and decides.
 * - **A bare mention is delivered too.** `@bot` with nothing after it is a nudge; dropping it would be a message read and
 *   silently not answered. The payload then ends at the colon, which is what was said.
 * - **A file is delivered, with or without words.** A photo, a PDF or a voice note is a person sending something, and
 *   `{ skip: "no text" }` used to drop all of them: the agent never heard about a document somebody needed read. The
 *   filter only says *which* file it is (`attachment`); fetching it is `src/inbox.ts`, and the path it lands on is what
 *   the payload names.
 */
import { chatTitle, seenChat } from "./chats.ts";
import type { ChatEvent } from "./envelope.ts";
import type { SeenChat } from "./state.ts";
import type { FileKind, TelegramChat, TelegramFileish, TelegramMessage, TelegramUpdate, TelegramUser } from "./telegram.ts";

export interface FilterContext {
	/**
	 * The chats this bot may relay, as the strings a payload carries: chat ids, and the @usernames it takes anywhere.
	 */
	readonly allowedChats: ReadonlySet<string>;
	/** The bot's own username from `getMe`, which is the mention to remove. Undefined when Telegram gave none. */
	readonly botUsername: string | undefined;
}

/**
 * The file a message carried, as Telegram described it: the id `getFile` is asked about, the name to write it under, and
 * what it is. `size` is Telegram's own, which a voice note and sometimes an audio file do not have at all — the inbox
 * treats a missing size as "learn it from the bytes".
 */
export interface Attachment {
	readonly fileId: string;
	readonly name: string;
	readonly kind: FileKind;
	readonly size?: number;
}

/** Either what to post, or why this update is not posted. The reason is for the log, one clause long. */
export type Reading =
	| { readonly skip: string }
	| {
			readonly event: ChatEvent;
			readonly chat: SeenChat;
			/** The file this message carried, which `src/inbox.ts` fetches once the filter has said yes. */
			readonly attachment?: Attachment;
	  };

export function readMessage(update: TelegramUpdate, context: FilterContext): Reading {
	const message: TelegramMessage | undefined = update.message;
	// `allowed_updates: ["message"]` means an edit never arrives. The check is repeated because the filter must not
	// depend on a request parameter it cannot see: a caller that forgets one must not relay an edit.
	if (message === undefined) return { skip: "not a message" };
	const from: TelegramUser | undefined = message.from;
	if (from === undefined) return { skip: "no sender" };
	if (from.is_bot === true) return { skip: "sent by a bot" };
	const chatId = String(message.chat.id);
	const handle = handleOf(from);
	// Either entry admits the message: the chat, or the person writing in it. The handle is undefined when Telegram gave
	// none, so a missing username can never match an entry — an empty one is not a wildcard.
	if (!context.allowedChats.has(chatId) && (handle === undefined || !context.allowedChats.has(handle))) {
		return {
			skip:
				handle === undefined
					? `chat ${chatId} is not in TELEGRAM_ALLOWED_CHATS`
					: `chat ${chatId} is not in TELEGRAM_ALLOWED_CHATS, and ${handle} is not either`,
		};
	}
	const attachment = attachmentIn(message);
	let text = written(message, context.botUsername);
	if (text === undefined) {
		// A sticker, a location, a poll, a service notice: Telegram sent something and none of it is words or a file.
		if (attachment === undefined) return { skip: "no text" };
		// The payload is one line of prose, so a file with no caption still needs a sentence: "sent a photo, with a file
		// at …" is what happened, and it is what still tells the agent a file was there when the fetch fails.
		text = describeAttachment(attachment);
	}
	const event: ChatEvent = {
		updateId: update.update_id,
		sender: senderName(from),
		username: from.username,
		chatId,
		chatTitle: titleFor(message.chat),
		replyToMessageId: message.reply_to_message?.message_id,
		text,
	};
	return {
		event,
		chat: seenChat(message.chat),
		...(attachment === undefined ? {} : { attachment }),
	};
}

/**
 * The sender's handle as an allowlist entry spells it, or undefined when Telegram gave none. Lower-cased because a
 * Telegram username is case-insensitive; "" is undefined rather than "@", because an empty username must never match an
 * entry: a missing handle is not a wildcard.
 */
function handleOf(from: TelegramUser): string | undefined {
	const username = from.username;
	if (username === undefined || username === "") return undefined;
	return `@${username.toLowerCase()}`;
}

/** A person's name as it should read in a sentence, with the username as the fallback rather than an empty string. */
export function senderName(from: TelegramUser): string {
	const name = [from.first_name, from.last_name].filter((part): part is string => part !== undefined && part !== "");
	if (name.length > 0) return name.join(" ");
	if (from.username !== undefined && from.username !== "") return `@${from.username}`;
	return String(from.id);
}

/**
 * What the person wrote, or undefined when they wrote nothing. A media message carries its words in `caption`; every
 * other carries them in `text`, and a caption of "" is Telegram saying there is none.
 */
function written(message: TelegramMessage, botUsername: string | undefined): string | undefined {
	const caption = message.caption;
	if (caption !== undefined && caption !== "") return stripMention(caption, botUsername);
	return message.text === undefined ? undefined : stripMention(message.text, botUsername);
}

/**
 * The file a message carried, or undefined when it carried none.
 *
 * At most one of the fields below is ever set — Telegram puts a photo in `photo`, a PDF in `document`, a voice note in
 * `voice` — so the order is only here so that a message with two of them is still one attachment.
 */
function attachmentIn(message: TelegramMessage): Attachment | undefined {
	const document = message.document;
	if (document !== undefined) {
		return described(document, "document", document.file_name ?? `file-${fileKey(document)}`);
	}
	// A photo arrives as the same picture at every size Telegram rendered, smallest first. The last entry is the largest,
	// and the only one worth reading; it carries no name, so the extension Telegram omits is put back by hand.
	const photo = message.photo?.at(-1);
	if (photo !== undefined) return described(photo, "photo", `photo-${fileKey(photo)}.jpg`);
	const voice = message.voice;
	if (voice !== undefined) return described(voice, "voice", `voice-${fileKey(voice)}.ogg`);
	const audio = message.audio;
	if (audio !== undefined) {
		// `title` first: it is what the person who sent the recording called it, and `file_name` is often the sender's
		// own name for the bytes.
		return described(audio, "audio", audio.title ?? audio.file_name ?? `audio-${fileKey(audio)}`);
	}
	const video = message.video;
	if (video !== undefined) return described(video, "video", video.file_name ?? `video-${fileKey(video)}`);
	// A GIF from the picker and a round video note are files a person sent. Telegram gives neither a name, and a video
	// note is always an `mp4`, which is what the extension says.
	const animation = message.animation;
	if (animation !== undefined) {
		return described(animation, "animation", animation.file_name ?? `animation-${fileKey(animation)}.mp4`);
	}
	const note = message.video_note;
	if (note !== undefined) return described(note, "video_note", `video-note-${fileKey(note)}.mp4`);
	return undefined;
}

function described(file: TelegramFileish, kind: FileKind, name: string): Attachment {
	return {
		fileId: file.file_id,
		name,
		kind,
		...(file.file_size === undefined ? {} : { size: file.file_size }),
	};
}

/**
 * What a file is called when Telegram gave it no name: its own unique id, which — unlike `file_id` — does not change
 * between two `getFile` calls, so the same message is always written under the same name.
 */
function fileKey(file: TelegramFileish): string {
	return file.file_unique_id ?? file.file_id;
}

/**
 * The sentence a caption-less file is delivered as. The kinds whose name is the sender's own say which file it is; a
 * photo and a voice note have no name of their own, so they say what arrived instead.
 */
function describeAttachment(attachment: Attachment): string {
	switch (attachment.kind) {
		case "photo":
			return "sent a photo";
		case "voice":
			return "sent a voice note";
		case "document":
			return `sent a file: ${attachment.name}`;
		case "audio":
			return `sent an audio file: ${attachment.name}`;
		case "video":
			return `sent a video: ${attachment.name}`;
		case "animation":
			return `sent a GIF: ${attachment.name}`;
		case "video_note":
			return "sent a round video message";
	}
}

/** A group has a title; a private chat is named after the person in it; either way the payload has one string. */
function titleFor(chat: TelegramChat): string | undefined {
	const title = chatTitle(chat);
	return title === "" ? undefined : title;
}

/**
 * Remove this bot's own `@mention`, keeping every other character.
 *
 * Case-insensitive, because Telegram usernames are, and anchored on a non-username character at the end so
 * `@mason_bot2` — somebody else — is not mistaken for `@mason_bot`. Leading and trailing whitespace goes with it: a
 * group message usually starts with the mention, and " hi" is not what the person typed. Nothing inside the message is
 * touched, so a code block or a quote arrives as it was written.
 */
export function stripMention(text: string, botUsername: string | undefined): string {
	if (botUsername === undefined || botUsername === "") return text;
	const pattern = new RegExp(`@${escapeRegExp(botUsername)}(?![A-Za-z0-9_])`, "gi");
	return text.replace(pattern, "").trim();
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
