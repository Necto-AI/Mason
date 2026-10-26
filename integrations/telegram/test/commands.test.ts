/**
 * The vocabulary from this container's side: where a slash starts a command, what `/help` says, and which word is the
 * relay's own.
 *
 * The words are mason's (`src/server/events.ts`), so what is pinned here is the relay's half of the bargain: a message is
 * a command candidate on the slash alone, `/help` never leaves the container, and the paragraph lists the same four names
 * Telegram's menu is set from (`src/commands.ts`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMANDS, commandIn, HELP_TEXT, isHelp } from "../src/commands.ts";

describe("where a command starts", () => {
	it("takes the text after a leading slash, and everything after it", () => {
		assert.equal(commandIn("/stop"), "stop");
		assert.equal(commandIn("/compact keep the pricing thread"), "compact keep the pricing thread");
		// The filter has already removed this bot's own mention, which is how a group sends `/stop@mason_bot`.
		assert.equal(commandIn("/stop now"), "stop now");
	});

	it("is not a command without the slash, or with nothing after it", () => {
		assert.equal(commandIn("stop"), undefined);
		assert.equal(commandIn("please /stop"), undefined);
		assert.equal(commandIn("/"), undefined);
		assert.equal(commandIn("/   "), undefined);
	});
});

describe("what /help says", () => {
	it("lists every command the relay forwards, and says what happens to anything else", () => {
		for (const command of COMMANDS) {
			assert.match(HELP_TEXT, new RegExp(`^/${command.name}: `, "m"), `${command.name} is in the list`);
		}
		assert.match(HELP_TEXT, /when the integration declares them/, "the list is mason's, not this chat's");
		assert.match(HELP_TEXT, /Anything else you type, including any other \/word, arrives as a message\./);
	});

	it("is its own, with or without words after it", () => {
		assert.equal(isHelp("help"), true);
		assert.equal(isHelp("help stop"), true);
		assert.equal(isHelp("helper"), false);
		assert.equal(isHelp("stop"), false);
	});
});
