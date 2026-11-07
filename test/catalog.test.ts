/**
 * `catalog/connectors.json` and its reader (`src/server/catalog.ts`).
 *
 * What is pinned is the file the release ships and the strictness of its parse. The shipped half is a promise to a
 * stranger: `mason setup` offers exactly what parses, so an entry that lost a field is a first run that offers nothing.
 * The refusal half is the reason the parser is written by hand rather than cast — an unknown key is a typo that would
 * otherwise mean its opposite (`optonal: true` reads as required, `secred: true` echoes a bot token), and a catalog that
 * accepts one is worse than a catalog that rejects the file.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { catalogEntry, parseCatalog, readCatalog } from "../src/server/catalog.ts";

/** One valid entry, so each refusal below changes one thing and nothing else. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "telegram",
		description: "Telegram, for one person or a group chat",
		image: "ghcr.io/denissud/mason-telegram",
		version: "0.2.0",
		connector: { capabilities: ["text", "markdown", "streaming"], commands: ["stop", "compact", "clear", "status"] },
		env: [{ name: "TELEGRAM_BOT_TOKEN", secret: true, prompt: "bot token from @BotFather" }],
		container: { port: 8082 },
		...overrides,
	};
}

function catalog(...entries: unknown[]): unknown {
	return { connectors: entries };
}

describe("the shipped catalog", () => {
	test("parses, and offers telegram with the env a first run asks for", async () => {
		const parsed = await readCatalog();
		assert.ok(parsed.connectors.length > 0, "an install that offers nothing is not a first run");
		const telegram = await catalogEntry("telegram");
		assert.equal(telegram.image, "ghcr.io/denissud/mason-telegram");
		assert.equal(telegram.container.port, 8082);
		assert.deepEqual(
			telegram.env.map((item) => item.name),
			["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_CHATS", "HTTPS_PROXY"],
		);
		// The token is the one answer setup must warn about before it echoes it into a terminal: the file says which
		// answer that is, and `scripts/setup.ts` reads the flag (`test/wizard`-level behaviour lives there).
		assert.equal(telegram.env[0]?.secret, true);
		// And the proxy is the one answer a host with a direct route does not have: leaving it out still starts.
		assert.equal(telegram.env[2]?.optional, true);
	});

	test("names no connector it cannot install, and hits the protocol's vocabulary", async () => {
		for (const connector of (await readCatalog()).connectors) {
			assert.match(connector.name, /^[a-z0-9][a-z0-9-]*$/, `${connector.name} is also an integration name`);
			assert.ok(connector.image.length > 0 && connector.version.length > 0);
			assert.ok(connector.connector.capabilities.length > 0, `${connector.name} claims nothing to carry`);
		}
	});

	test("an entry it does not hold is refused by name, and says what there is", async () => {
		await assert.rejects(catalogEntry("teleram"), /no connector "teleram".*telegram/s);
	});
});

describe("the parse is closed", () => {
	test("an unknown key on an entry fails", () => {
		assert.throws(
			() => parseCatalog(catalog(entry({ images: "typo" }))),
			/unknown key "images"/,
			"a typo in a key is a field that silently does nothing",
		);
	});

	test("an unknown key on an env item fails", () => {
		assert.throws(
			() =>
				parseCatalog(catalog(entry({ env: [{ name: "TELEGRAM_BOT_TOKEN", prompt: "bot token", secred: true }] }))),
			/unknown key "secred"/,
		);
	});

	test("an unknown key at the top of the file fails", () => {
		assert.throws(() => parseCatalog({ connectors: [], version: 1 }), /unknown key "version"/);
	});

	test("a key mason has no reader for cannot ride along on the container", () => {
		assert.throws(() => parseCatalog(catalog(entry({ container: { port: 8082, host: 9000 } }))), /unknown key/);
	});
});

describe("an entry that cannot be installed is a refusal", () => {
	test("an entry with no image fails", () => {
		const { image: _image, ...rest } = entry();
		assert.throws(() => parseCatalog(catalog(rest)), /has no "image"/);
	});

	test("an env item with no name fails", () => {
		assert.throws(
			() => parseCatalog(catalog(entry({ env: [{ prompt: "bot token from @BotFather" }] }))),
			/has no "name"/,
		);
	});

	test("an env name that is not an environment variable fails", () => {
		assert.throws(
			() => parseCatalog(catalog(entry({ env: [{ name: "bot token", prompt: "x" }] }))),
			/environment names are/,
		);
	});

	test("a capability outside the protocol's vocabulary fails", () => {
		assert.throws(
			() => parseCatalog(catalog(entry({ connector: { capabilities: ["telepathy"], commands: ["stop"] } }))),
			/the protocol's vocabulary is/,
		);
	});

	test("a command outside the protocol's closed set fails", () => {
		assert.throws(
			() => parseCatalog(catalog(entry({ connector: { capabilities: ["text"], commands: ["pause"] } }))),
			/the protocol's vocabulary is stop, compact, clear, status/,
		);
	});

	test("a port that is not a TCP port fails", () => {
		assert.throws(() => parseCatalog(catalog(entry({ container: { port: 0 } }))), /1 to 65535/);
		assert.throws(() => parseCatalog(catalog(entry({ container: { port: 80_000 } }))), /1 to 65535/);
		assert.throws(() => parseCatalog(catalog(entry({ container: { port: "8082" } }))), /1 to 65535/);
	});

	test("two connectors with one name fail", () => {
		assert.throws(() => parseCatalog(catalog(entry(), entry())), /two connectors are named "telegram"/);
	});

	test("a name mason could not write as an integration fails", () => {
		assert.throws(() => parseCatalog(catalog(entry({ name: "Telegram Bot" }))), /not a usable name/);
	});

	test("a file with no connectors list fails", () => {
		assert.throws(() => parseCatalog({}), /"connectors" is not a list/);
		assert.throws(() => parseCatalog([]), /is not a JSON object/);
	});
});
