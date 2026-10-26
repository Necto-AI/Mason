/**
 * Configuration: what starts, what refuses, and what the refusal says.
 *
 * Every case is a variable an operator can get wrong, and the assertion that matters is the same in each: the refusal
 * names the variable, because a container that exits with "invalid configuration" is a container somebody has to read the
 * source of.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, readConfig } from "../src/env.ts";

const SECRET = "0f".repeat(32);

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		TELEGRAM_BOT_TOKEN: "123:abc",
		MASON_EVENT_URL: "http://mason:8787/api/events/telegram",
		MASON_TRIGGER_SECRET: SECRET,
		TELEGRAM_ALLOWED_CHATS: "-1001234",
		...overrides,
	};
}

describe("the configuration", () => {
	it("reads the four variables the trigger face cannot run without", () => {
		const config = readConfig(environment());
		assert.equal(config.botToken, "123:abc");
		assert.equal(config.eventUrl, "http://mason:8787/api/events/telegram");
		assert.equal(config.triggerSecret, SECRET);
		assert.deepEqual(config.allowedChats, ["-1001234"]);
		assert.equal(config.httpsProxy, undefined);
		assert.equal(config.dataDir, "/data");
		assert.equal(config.port, 8082);
	});

	it("names every missing variable at once rather than one per attempt", () => {
		assert.throws(
			() => readConfig({}),
			(error: unknown) =>
				error instanceof ConfigError &&
				error.message.includes(
					"TELEGRAM_BOT_TOKEN, MASON_EVENT_URL, MASON_TRIGGER_SECRET, TELEGRAM_ALLOWED_CHATS are not set",
				),
		);
	});

	it("refuses a secret short enough to guess", () => {
		assert.throws(() => readConfig(environment({ MASON_TRIGGER_SECRET: "short" })), /32 is the floor/);
	});

	it("refuses a door URL that is not a URL", () => {
		assert.throws(() => readConfig(environment({ MASON_EVENT_URL: "mason/api/events" })), /not an http\(s\) URL/);
	});

	it("splits and trims the allowlist, and refuses one that names nothing", () => {
		assert.deepEqual(readConfig(environment({ TELEGRAM_ALLOWED_CHATS: " -1001234 , 4711 ," })).allowedChats, [
			"-1001234",
			"4711",
		]);
		assert.throws(
			() => readConfig(environment({ TELEGRAM_ALLOWED_CHATS: " , " })),
			/TELEGRAM_ALLOWED_CHATS names no chat/,
		);
	});

	it("keeps the proxy and the data directory when they are set, and moves the port when asked", () => {
		const config = readConfig(
			environment({ HTTPS_PROXY: "http://vpn:1080", DATA_DIR: "/tmp/telegram", PORT: "9000" }),
		);
		assert.equal(config.httpsProxy, "http://vpn:1080");
		assert.equal(config.dataDir, "/tmp/telegram");
		assert.equal(config.port, 9_000);
	});

	it("refuses a port that is not one", () => {
		assert.throws(() => readConfig(environment({ PORT: "eighty" })), /PORT is not a port number/);
	});
});
