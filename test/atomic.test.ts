/**
 * `src/server/atomic.ts` — the one writer of the service half's files.
 *
 * What is pinned is the promise a reader relies on: a file is replaced whole, or not at all, and nothing outside the owner
 * can read it. The concurrency case is the one that cost a real bug: two writes from one process to one path are two
 * renames of one temp name, and the target ends up holding the first document's bytes under the second one's length — a
 * file that parses nowhere. Both halves are checked here, because the ledger that found it
 * (`scripts/chat.ts`) is not the only writer.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { writeFileAtomic, writeTextAtomic } from "../src/server/atomic.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-atomic-"));
	directories.add(directory);
	return directory;
}

describe("writeFileAtomic", () => {
	test("writes JSON with a trailing newline, private, in a private directory", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "service", "config.json");
		await writeFileAtomic(path, { connectors: [] });
		assert.equal(await readFile(path, "utf8"), `${JSON.stringify({ connectors: [] }, null, 2)}\n`);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(directory, "service"))).mode & 0o777, 0o700);
	});

	test("concurrent writes to one path leave one whole document, not two interleaved", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "console-ledger.json");
		// Two writes in one turn is the shape that broke: the acknowledgement and the outbox entry of a single delivery.
		// The winner is either document; a file that parses is the whole assertion.
		await Promise.all([
			writeFileAtomic(path, { a: "x".repeat(400) }),
			writeFileAtomic(path, { b: "y".repeat(400) }),
			writeFileAtomic(path, { c: "z".repeat(400) }),
		]);
		const text = await readFile(path, "utf8");
		const parsed = JSON.parse(text) as Record<string, string>;
		assert.equal(Object.keys(parsed).length, 1, `one document, and it is one of them: ${text.slice(0, 40)}`);
	});

	test("no temporary file is left behind", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "x.json");
		await Promise.all([writeFileAtomic(path, { one: 1 }), writeFileAtomic(path, { two: 2 })]);
		const { readdir } = await import("node:fs/promises");
		assert.deepEqual(await readdir(directory), ["x.json"]);
	});
});

describe("writeTextAtomic", () => {
	test("writes text as it stands", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "connectors", "telegram", "compose.yaml");
		await writeTextAtomic(path, "name: a1b2c3d4-telegram\n");
		assert.equal(await readFile(path, "utf8"), "name: a1b2c3d4-telegram\n");
		assert.equal((await stat(path)).mode & 0o777, 0o600, "it carries the connector's credential");
	});
});
