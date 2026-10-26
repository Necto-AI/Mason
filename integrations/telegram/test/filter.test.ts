/**
 * The gate: what becomes an event, and what a message says once it does.
 *
 * Every case here is one the issue names — a bot's message, an edit, a chat we did not choose, a command — plus the two
 * decisions the issue left open (a command is delivered; a bare mention is delivered) which are pinned so that pinning
 * them is the point.
 *
 * The second half is files: a photo, a PDF, a voice note and a video each become an event, with or without a caption, and
 * each says which file it is and what the payload will call it. The name fallbacks are pinned by name because they are
 * what a person reads in the payload (`sent a file: report.pdf`) and what the volume ends up holding.
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

describe("a GIF and a round video note", () => {
	it("are files a person sent, so they become events", () => {
		const gif = readMessage(
			update({ text: undefined, animation: { file_id: "A1", file_unique_id: "U1", file_name: "party.mp4", file_size: 2_048 } }),
			context(),
		);
		assert.ok("event" in gif, "a GIF from the picker is a file, not a service notice");
		if ("event" in gif) {
			assert.equal(gif.event.text, "sent a GIF: party.mp4");
			assert.equal(gif.attachment?.kind, "animation");
		}

		const note = readMessage(update({ text: undefined, video_note: { file_id: "V1", file_unique_id: "U2" } }), context());
		assert.ok("event" in note);
		if ("event" in note) {
			assert.equal(note.event.text, "sent a round video message");
			assert.match(note.attachment?.name ?? "", /^video-note-U2\.mp4$/);
		}
	});

	it("still skips what is neither words nor a file", () => {
		const sticker = readMessage(update({ text: undefined, sticker: { file_id: "S1" } }), context());
		assert.deepEqual(sticker, { skip: "no text" });
	});
});

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

	it("drops a message that is neither words nor a file — a sticker, a location, a poll, a service notice", () => {
		const sticker = update({ text: undefined, sticker: { file_id: "s1", emoji: "🐳" } });
		assert.deepEqual(readMessage(sticker, context()), { skip: "no text" });
		const location = update({ text: undefined, location: { latitude: 1, longitude: 2 } });
		assert.deepEqual(readMessage(location, context()), { skip: "no text" });
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

/** A message with one file and no words, which is what a file sent from a phone looks like. */
function withFile(fields: Record<string, unknown>, rest: Record<string, unknown> = {}): TelegramUpdate {
	return update({ text: undefined, ...fields, ...rest });
}

describe("a message with a file", () => {
	it("delivers a photo without a caption as \"sent a photo\", with the largest size as its name", () => {
		const photo = withFile({
			photo: [
				{ file_id: "small", file_unique_id: "u1", width: 90, height: 90, file_size: 1_000 },
				{ file_id: "large", file_unique_id: "u2", width: 1_280, height: 1_280, file_size: 200_000 },
			],
		});

		const reading = readMessage(photo, context());

		assert.ok("event" in reading);
		assert.equal(reading.event.text, "sent a photo");
		assert.deepEqual(reading.attachment, { fileId: "large", name: "photo-u2.jpg", kind: "photo", size: 200_000 });
	});

	it("delivers a photo with a caption as what the person wrote, and keeps the file beside it", () => {
		const photo = withFile({ photo: [{ file_id: "f1", file_unique_id: "u1", file_size: 900 }] }, { caption: "look" });

		const reading = readMessage(photo, context());

		assert.ok("event" in reading);
		assert.equal(reading.event.text, "look");
		assert.equal(reading.attachment?.kind, "photo");
		assert.equal(reading.attachment?.name, "photo-u1.jpg");
	});

	it("delivers a PDF as \"sent a file: report.pdf\", because the name is the sender's own", () => {
		const document = withFile({
			document: {
				file_id: "f2",
				file_unique_id: "u2",
				file_name: "report.pdf",
				mime_type: "application/pdf",
				file_size: 4_096,
			},
		});

		const reading = readMessage(document, context());

		assert.ok("event" in reading);
		assert.equal(reading.event.text, "sent a file: report.pdf");
		assert.deepEqual(reading.attachment, { fileId: "f2", name: "report.pdf", kind: "document", size: 4_096 });
	});

	it("delivers a PDF with a caption as the caption, and does not put the file's name in the text twice", () => {
		const document = withFile(
			{ document: { file_id: "f2", file_name: "report.pdf", file_size: 4_096 } },
			{ caption: "the numbers you asked for" },
		);

		const reading = readMessage(document, context());

		assert.ok("event" in reading);
		assert.equal(reading.event.text, "the numbers you asked for");
		assert.equal(reading.attachment?.name, "report.pdf");
	});

	it("delivers a voice note as \"sent a voice note\", named for its own id and Telegram's own extension", () => {
		const voice = withFile({ voice: { file_id: "f3", file_unique_id: "u3", duration: 7, mime_type: "audio/ogg" } });

		const reading = readMessage(voice, context());

		assert.ok("event" in reading);
		assert.equal(reading.event.text, "sent a voice note");
		assert.deepEqual(reading.attachment, { fileId: "f3", name: "voice-u3.ogg", kind: "voice" });
	});

	it("delivers a video named by its file name, and a video without one named for its id", () => {
		const named = withFile({ video: { file_id: "f4", file_name: "clip.mp4", file_size: 10_000 } });
		const anonymous = withFile({ video: { file_id: "f5", file_unique_id: "u5" } });

		const namedReading = readMessage(named, context());
		const anonymousReading = readMessage(anonymous, context());

		assert.ok("event" in namedReading);
		assert.ok("event" in anonymousReading);
		assert.equal(namedReading.event.text, "sent a video: clip.mp4");
		assert.equal(namedReading.attachment?.name, "clip.mp4");
		assert.equal(anonymousReading.event.text, "sent a video: video-u5");
	});

	it("names an audio file by its title first, then by its file name, then by its id", () => {
		const titled = withFile({
			audio: { file_id: "f6", file_unique_id: "u6", file_name: "track.mp3", title: "Evening" },
		});
		const filed = withFile({ audio: { file_id: "f7", file_unique_id: "u7", file_name: "track.mp3" } });
		const anonymous = withFile({ audio: { file_id: "f8", file_unique_id: "u8" } });

		const titledReading = readMessage(titled, context());
		const filedReading = readMessage(filed, context());
		const anonymousReading = readMessage(anonymous, context());

		assert.ok("event" in titledReading);
		assert.ok("event" in filedReading);
		assert.ok("event" in anonymousReading);
		assert.equal(titledReading.event.text, "sent an audio file: Evening");
		assert.equal(filedReading.attachment?.name, "track.mp3");
		assert.equal(anonymousReading.attachment?.name, "audio-u8");
	});

	it("names a document Telegram gave no name for, rather than writing an empty name", () => {
		const document = withFile({ document: { file_id: "f9", file_unique_id: "u9", file_size: 12 } });

		const reading = readMessage(document, context());

		assert.ok("event" in reading);
		assert.equal(reading.attachment?.name, "file-u9");
	});

	it("strips this bot's mention from a caption as it does from a text", () => {
		const document = withFile(
			{ document: { file_id: "f2", file_name: "report.pdf" } },
			{ caption: "@mason_bot read this" },
		);

		const reading = readMessage(document, context());

		assert.ok("event" in reading);
		assert.equal(reading.event.text, "read this");
	});

	it("carries the chat and the reply target like any other message, so the file arrives with a room to answer in", () => {
		const document = withFile(
			{ document: { file_id: "f2", file_name: "report.pdf" } },
			{ reply_to_message: { message_id: 76 } },
		);

		const reading = readMessage(document, context());

		assert.ok("event" in reading);
		assert.equal(reading.event.chatId, "-1001234");
		assert.equal(reading.event.chatTitle, "Team chat");
		assert.equal(reading.event.replyToMessageId, 76);
		assert.deepEqual(reading.chat, { id: "-1001234", title: "Team chat", type: "supergroup" });
	});
});
