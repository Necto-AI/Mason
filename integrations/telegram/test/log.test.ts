/**
 * The log is the one place a credential could leave this container by accident, so it is pinned.
 *
 * Three shapes: a secret this process knows, the bot token inside the URL it is always in, and an `Authorization` header
 * a proxy quoted back. Each is what an error message looks like just before it would have printed somebody's credential.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLog, describeError, redact } from "../src/log.ts";

const TOKEN = "123456789:AAF-abcdefghijklmnopqrstuvwxyz012345";
const SECRET = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

describe("redacting a line", () => {
	it("replaces the configured secrets wherever they appear", () => {
		const line = redact(`token=${TOKEN} secret=${SECRET}`, [TOKEN, SECRET]);
		assert.equal(line, "token=<redacted> secret=<redacted>");
		assert.ok(!line.includes(TOKEN));
		assert.ok(!line.includes(SECRET));
	});

	it("catches a token that arrived inside a Telegram URL rather than as a known secret", () => {
		assert.equal(
			redact("request to https://api.telegram.org/bot123456789:AAF-failed/sendMessage", []),
			"request to https://api.telegram.org/bot<redacted>/sendMessage",
		);
	});

	it("replaces an Authorization header, quoted or bare", () => {
		assert.equal(redact('Authorization: Bearer abc.def', []), "Authorization: <redacted>");
		assert.equal(redact('{ "authorization": "Basic dXNlcg==" }', []), '{ "authorization": <redacted> }');
	});

	it("leaves an unrelated line alone", () => {
		assert.equal(redact("delivered tg-8811 (chat.message)", []), "delivered tg-8811 (chat.message)");
	});
});

describe("describing a failure", () => {
	it("keeps the cause fetch would otherwise swallow", () => {
		const failure = new Error("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.telegram.org") });
		assert.equal(describeError(failure), "fetch failed: getaddrinfo ENOTFOUND api.telegram.org");
	});

	it("says nothing twice when the cause is the message", () => {
		assert.equal(describeError(new Error("fetch failed", { cause: new Error("fetch failed") })), "fetch failed");
	});

	it("describes a thrown non-error without pretending it is one", () => {
		assert.equal(describeError("nope"), "nope");
	});
});

describe("the container's log", () => {
	it("prefixes every line with the integration name and redacts before writing", () => {
		const lines: string[] = [];
		const log = createLog([TOKEN], (line) => lines.push(line));
		log("info", `calling https://api.telegram.org/bot${TOKEN}/getMe`);
		log("warn", "throttled");
		assert.deepEqual(lines, [
			"[telegram] calling https://api.telegram.org/bot<redacted>/getMe",
			"[telegram] warn: throttled",
		]);
	});
});
