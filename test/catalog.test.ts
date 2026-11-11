/**
 * `catalog/connectors.json` and its reader (`src/server/catalog.ts`).
 *
 * What is pinned is the file the release ships and the strictness of its parse. The shipped half is a promise to a
 * stranger: `mason setup` offers exactly what parses, so the file 0.1.0 ships is empty on purpose — the console connector
 * is built in and not an entry, and the one entry this file held named an image no workflow publishes (#151). A refusal
 * here is the reason a first run ends with a sentence and not a container that can never connect. The refusal half is
 * the reason the parser is written by hand rather than cast — an unknown key is a typo that would otherwise mean its
 * opposite (`optonal: true` reads as required, `secred: true` echoes a bot token), and a catalog that accepts one is
 * worse than a catalog that rejects the file.
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
	test("ships empty, on purpose, so a stranger is offered only what can run", async () => {
		const parsed = await readCatalog();
		// The console connector is built in and is not an entry; the telegram image this file used to name is not
		// published, so offering it was a first run that ended at `403` (#151). The parser stays, and the entry comes
		// back when its image travels with a release.
		assert.deepEqual(parsed.connectors, [], "0.1.0 ships the built-in console connector, not a catalog entry");
	});

	test("an entry parses into the name, the image and the protocol's vocabulary", () => {
		const [parsed] = parseCatalog(catalog(entry())).connectors;
		assert.equal(parsed?.name, "telegram");
		assert.equal(parsed?.image, "ghcr.io/denissud/mason-telegram");
		assert.equal(parsed?.version, "0.2.0");
		assert.deepEqual(parsed?.connector.capabilities, ["text", "markdown", "streaming"]);
		assert.deepEqual(parsed?.connector.commands, ["stop", "compact", "clear", "status"]);
	});

	test("an entry it does not hold is refused by name, and says how to get a connector", async () => {
		// A stranger who typed a catalog name this release does not ship needs the two connectors it does ship, not a
		// list of none: the empty catalog is a decision, and the refusal has to read like one.
		await assert.rejects(
			catalogEntry("telegram"),
			/ships no catalog connectors.*--connector console.*--connector custom/s,
		);
		await assert.rejects(catalogEntry("teleram"), /there is no connector "teleram"/);
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
