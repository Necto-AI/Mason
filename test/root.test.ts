/**
 * `src/server/root.ts` — the directory above the home.
 *
 * A bot is today's home, unchanged, one directory under the root; `common/` sits beside it and is never a bot. These
 * tests pin the three things every command depends on: what counts as a bot, how a target is chosen (`-b` over
 * `MASON_BOT` over the only bot over a refusal that names them), and the two refusals — a root whose halves sit at the
 * root, and a name that is not there. Every root here is a temporary directory.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
	botHome,
	expandHome,
	readRoot,
	refuseHomeEnv,
	refuseLegacyRoot,
	resolveBot,
	rootPath,
} from "../src/server/root.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-root-"));
	directories.add(directory);
	return directory;
}

/** One bot: its name and whichever halves the test wants it to have. */
async function bot(
	root: string,
	name: string,
	halves: readonly ("agent" | "service")[] = ["agent", "service"],
): Promise<string> {
	for (const half of halves) await mkdir(join(root, name, half), { recursive: true, mode: 0o700 });
	return join(root, name);
}

describe("the root and its bots", () => {
	test("lists bot directories by name, and never common, a hidden directory or a directory with no halves", async () => {
		const root = await tempRoot();
		await bot(root, "bob");
		await bot(root, "alice");
		await mkdir(join(root, "common"), { recursive: true });
		await mkdir(join(root, ".git"), { recursive: true });
		await mkdir(join(root, "notes"), { recursive: true });
		const read = readRoot(root);
		assert.deepEqual(
			read.bots.map((entry) => entry.name),
			["alice", "bob"],
		);
		assert.equal(read.commonDir, join(root, "common"));
	});

	test("a root that does not exist yet is an empty fleet, not a refusal", async () => {
		const root = join(await tempRoot(), "missing");
		assert.deepEqual(readRoot(root).bots, []);
	});

	test("a root whose halves sit at the root is refused with the move, and nothing is created", async () => {
		const root = await tempRoot();
		await writeFile(join(root, "soul.md"), "an operator's soul\n", "utf8");
		await mkdir(join(root, "agent"), { recursive: true });
		assert.throws(
			() => readRoot(root),
			(error: Error) =>
				/holds a single home's halves at the root/.test(error.message) &&
				/agent, soul\.md/.test(error.message) &&
				/MASON_HOME/.test(error.message),
		);
	});
});

describe("which bot a command is about", () => {
	test("-b beats MASON_BOT, MASON_BOT beats the only bot, and the only bot needs no answer", async () => {
		const root = await tempRoot();
		await bot(root, "alice");
		await bot(root, "bob");
		const read = readRoot(root);
		assert.equal(resolveBot(read, { bot: "alice", env: { MASON_BOT: "bob" } }).name, "alice");
		assert.equal(resolveBot(read, { env: { MASON_BOT: "bob" } }).name, "bob");
		assert.throws(() => resolveBot(read, { env: {} }), /holds 2 bots: alice, bob/);
		assert.throws(() => resolveBot(read, { env: {} }), /-b <name>/);
	});

	test("a root with one bot targets it with nothing set", async () => {
		const root = await tempRoot();
		const home = await bot(root, "alice");
		assert.deepEqual(resolveBot(readRoot(root), { env: {} }), { root, name: "alice", home });
	});

	test("a name that is not there is a refusal listing what is, never a fall-through", async () => {
		const root = await tempRoot();
		await bot(root, "alice");
		assert.throws(
			() => resolveBot(readRoot(root), { bot: "alise", env: {} }),
			/there is no bot "alise" under .*: it knows alice/,
		);
		assert.throws(() => resolveBot(readRoot(root), { bot: "Alice", env: {} }), /not a bot name/);
	});

	test("a root with no bot says the command that creates one", async () => {
		const root = await tempRoot();
		assert.throws(() => resolveBot(readRoot(root), { env: {} }), /has no bot yet/);
		assert.throws(() => resolveBot(readRoot(root), { env: {} }), /mason onboard/);
	});
});

describe("the paths", () => {
	test("rootPath follows MASON_ROOT, else ~/.mason, and expands a leading ~", () => {
		assert.equal(rootPath({}), join(homedir(), ".mason"));
		assert.equal(rootPath({ MASON_ROOT: "/srv/mason" }), "/srv/mason");
		assert.equal(expandHome("~/mason").startsWith("/"), true);
		assert.equal(botHome("/srv/mason", "alice"), "/srv/mason/alice");
	});

	test("a fleet command refuses MASON_HOME, because a home is not a root", () => {
		assert.doesNotThrow(() => refuseHomeEnv({}));
		assert.throws(() => refuseHomeEnv({ MASON_HOME: "/home/x/.mason" }), /MASON_HOME names one home/);
	});

	test("refuseLegacyRoot is quiet on an empty or a fleet root", async () => {
		const root = await tempRoot();
		assert.doesNotThrow(() => refuseLegacyRoot(root));
		await bot(root, "alice");
		assert.doesNotThrow(() => refuseLegacyRoot(root));
	});
});
