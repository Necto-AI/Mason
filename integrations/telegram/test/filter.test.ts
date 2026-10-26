/**
 * The gate: what becomes an event, and what a message says once it does.
 *
 * Every case here is one the issue names — a bot's message, an edit, a chat we did not choose, a command — plus the two
 * decisions the issue left open (a command is delivered; a bare mention is delivered) which are pinned so that pinning
 * them is the point.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readMessage, senderName, stripMention, type FilterContext } from "../src/filter.ts";
import type { TelegramUpdate } from "../src/telegram.ts";

const allowed = new Set(["-1001234"]);

function context(overrides: Partial<FilterContext> = {}): FilterContext {
	return { allowedChats: allowed, botUsername: "mason_bot", ...overrides };
}

function update(overrides: Record<string, unknown> = {}): TelegramUpdate {
	return {
		update_id: 900,
		message: {
			message_id: 77,
			date: 1_700_000_000,
			text: "ship it?",
			from: { id: 11, first_name: "Ilya", username: "ilya" },
			chat: { id: -1_001_234, type: "supergroup", title: "Team chat" },
			...overrides,
		},
	};
}

describe("which updates become events", () => {
	it("reads a plain message in an allowed chat", () => {
		const reading = readMessage(update(), context());
		assert.ok("event" in reading);
		assert.equal(reading.event.sender, "Ilya");
		assert.equal(reading.event.chatId, "-1001234");
		assert.equal(reading.event.text, "ship it?");
	});

	it("drops a message a bot sent, including another instance of this one", () => {
		const bot = update({ from: { id: 12, first_name: "Relay", is_bot: true } });
		assert.deepEqual(readMessage(bot, context()), { skip: "sent by a bot" });
	});

	it("drops an edit, which Telegram should not send but the filter does not trust it not to", () => {
		const edited: TelegramUpdate = { update_id: 901, edited_message: update().message };
		assert.deepEqual(readMessage(edited, context()), { skip: "not a message" });
	});

	it("drops a chat that is not in the allowlist, and does not add it to the chat list", () => {
		const other = update({ chat: { id: -5_555, type: "group", title: "Somewhere else" } });
		const reading = readMessage(other, context());
		assert.deepEqual(reading, { skip: "chat -5555 is not in TELEGRAM_ALLOWED_CHATS" });
		assert.ok(!("chat" in reading));
	});

	it("drops a message with no text — a sticker, a photo, a service notice", () => {
		const media = update({ text: undefined });
		assert.deepEqual(readMessage(media, context()), { skip: "no text" });
	});

	it("delivers a /start command as the message it is", () => {
		const start = update({ text: "/start" });
		const reading = readMessage(start, context());
		assert.ok("event" in reading);
		assert.equal(reading.event.text, "/start");
	});

	it("delivers a command addressed to this bot with the mention removed", () => {
		const command = update({ text: "/help@mason_bot" });
		const reading = readMessage(command, context());
		assert.ok("event" in reading);
		assert.equal(reading.event.text, "/help");
	});

	it("carries the reply target, the chat title and the chat as list_chats shows it", () => {
		const reply = update({ reply_to_message: { message_id: 76, date: 1, chat: { id: -1_001_234, type: "supergroup" } } });
		const reading = readMessage(reply, context());
		assert.ok("event" in reading);
		assert.equal(reading.event.replyToMessageId, 76);
		assert.equal(reading.event.chatTitle, "Team chat");
		assert.deepEqual(reading.chat, { id: "-1001234", title: "Team chat", type: "supergroup" });
	});
});

describe("stripping this bot's own mention", () => {
	it("removes a leading mention and the whitespace it left", () => {
		assert.equal(stripMention("@mason_bot ship it?", "mason_bot"), "ship it?");
	});

	it("removes a mention anywhere in the message and keeps the rest as it was typed", () => {
		assert.equal(stripMention("ask @mason_bot about it", "mason_bot"), "ask  about it");
	});

	it("is case-insensitive, because a Telegram username is", () => {
		assert.equal(stripMention("@Mason_Bot ship it?", "mason_bot"), "ship it?");
	});

	it("leaves a longer username that merely starts the same", () => {
		assert.equal(stripMention("@mason_bot2 ship it?", "mason_bot"), "@mason_bot2 ship it?");
	});

	it("changes nothing when the bot has no username to strip", () => {
		assert.equal(stripMention("@someone ship it?", undefined), "@someone ship it?");
	});
});

describe("naming the sender", () => {
	it("joins a first and last name", () => {
		assert.equal(senderName({ id: 1, first_name: "Ilya", last_name: "Sudakov" }), "Ilya Sudakov");
	});

	it("falls back to the handle when Telegram gave no name", () => {
		assert.equal(senderName({ id: 1, first_name: "", username: "ilya" }), "@ilya");
	});

	it("falls back to the id when there is neither", () => {
		assert.equal(senderName({ id: 1, first_name: "" }), "1");
	});
});
