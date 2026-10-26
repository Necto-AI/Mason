/**
 * Whether an update becomes an event, and what it says if it does.
 *
 * This is the gate the issue is really about: the bot may be in chats nobody chose, a chat may contain other bots, and
 * Telegram will happily send an edit. Every one of those is dropped here, before anything is signed or posted, because an
 * event that reaches the door has already been worth a model turn — the door has no second filter and no way to ask.
 *
 * Three decisions worth naming:
 *
 * - **A chat we did not choose must not even become a chat.** The allowlist is checked before anything else is read, and
 *   a chat that fails it is not added to `list_chats` either: the list is the agent's map of where it may write, and a
 *   chat it may not write to does not belong on it.
 * - **Commands are delivered.** `/start`, `/help` and a `/command@this_bot` with the bot's own mention stripped are
 *   ordinary messages: a person typed them, in a chat we chose, and deciding here which commands mean something would be
 *   this container guessing at what the agent should hear. The model sees the text and decides.
 * - **A bare mention is delivered too.** `@bot` with nothing after it is a nudge; dropping it would be a message read and
 *   silently not answered. The payload then ends at the colon, which is what was said.
 */
import { chatTitle, seenChat } from "./chats.ts";
import type { ChatEvent } from "./envelope.ts";
import type { SeenChat } from "./state.ts";
import type { TelegramChat, TelegramMessage, TelegramUpdate, TelegramUser } from "./telegram.ts";

export interface FilterContext {
	/** The chats this bot may relay, as the strings a payload carries. */
	readonly allowedChats: ReadonlySet<string>;
	/** The bot's own username from `getMe`, which is the mention to remove. Undefined when Telegram gave none. */
	readonly botUsername: string | undefined;
}

/** Either what to post, or why this update is not posted. The reason is for the log, one clause long. */
export type Reading =
	| { readonly skip: string }
	| { readonly event: ChatEvent; readonly chat: SeenChat };

export function readMessage(update: TelegramUpdate, context: FilterContext): Reading {
	const message: TelegramMessage | undefined = update.message;
	// `allowed_updates: ["message"]` means an edit never arrives. The check is repeated because the filter must not
	// depend on a request parameter it cannot see: a caller that forgets one must not relay an edit.
	if (message === undefined) return { skip: "not a message" };
	const from: TelegramUser | undefined = message.from;
	if (from === undefined) return { skip: "no sender" };
	if (from.is_bot === true) return { skip: "sent by a bot" };
	const chatId = String(message.chat.id);
	if (!context.allowedChats.has(chatId)) return { skip: `chat ${chatId} is not in TELEGRAM_ALLOWED_CHATS` };
	const text: string | undefined = message.text;
	if (text === undefined) return { skip: "no text" };
	const event: ChatEvent = {
		updateId: update.update_id,
		sender: senderName(from),
		username: from.username,
		chatId,
		chatTitle: titleFor(message.chat),
		replyToMessageId: message.reply_to_message?.message_id,
		text: stripMention(text, context.botUsername),
	};
	return { event, chat: seenChat(message.chat) };
}

/** A person's name as it should read in a sentence, with the username as the fallback rather than an empty string. */
export function senderName(from: TelegramUser): string {
	const name = [from.first_name, from.last_name].filter((part): part is string => part !== undefined && part !== "");
	if (name.length > 0) return name.join(" ");
	if (from.username !== undefined && from.username !== "") return `@${from.username}`;
	return String(from.id);
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
