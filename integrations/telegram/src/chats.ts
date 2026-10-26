/**
 * The chats this bot has relayed, kept so the agent can name one without a human pasting an id.
 *
 * `list_chats` is the whole reason this exists: the agent learns chat ids by reading this list, not by asking. Only
 * chats that passed the allowlist are recorded — a list that also held the chats we did *not* choose would be a list of
 * ids the agent cannot write to, and it would leak the bot's membership into a prompt.
 *
 * The list is in memory and flushed to the volume once per batch, beside the offset: it changes only when a new chat
 * speaks for the first time, so the flush is rare, and a batch that fails halfway leaves a list at worst one chat behind
 * — which the next message from that chat repairs.
 */
import type { SeenChat } from "./state.ts";
import type { TelegramChat } from "./telegram.ts";

/**
 * A chat's name for a person. Groups and channels carry a `title`; a private chat carries the other party's name and no
 * title at all, so the fallback is what makes the list readable instead of a row of numbers.
 */
export function chatTitle(chat: TelegramChat): string {
	if (chat.title !== undefined && chat.title !== "") return chat.title;
	const name = [chat.first_name, chat.last_name].filter((part): part is string => part !== undefined && part !== "");
	if (name.length > 0) return name.join(" ");
	if (chat.username !== undefined && chat.username !== "") return `@${chat.username}`;
	return String(chat.id);
}

/** A chat as `list_chats` reports it: the id as a string, because that is what `send_message` takes. */
export function seenChat(chat: TelegramChat): SeenChat {
	return { id: String(chat.id), title: chatTitle(chat), type: chat.type };
}

/** The chats seen so far, in the order they were first seen, with a write owed when one is added. */
export class ChatDirectory {
	readonly #chats: SeenChat[] = [];
	#dirty = false;

	constructor(chats: readonly SeenChat[] = []) {
		this.#chats.push(...chats);
	}

	list(): SeenChat[] {
		return [...this.#chats];
	}

	/** Whether the list grew. A chat that spoke before changes nothing, so it is not worth a write. */
	add(chat: SeenChat): boolean {
		if (this.#chats.some((seen) => seen.id === chat.id)) return false;
		this.#chats.push(chat);
		this.#dirty = true;
		return true;
	}

	get dirty(): boolean {
		return this.#dirty;
	}

	/** Called by the writer after the flush, so a failed write is retried with the next batch. */
	clean(): void {
		this.#dirty = false;
	}
}
