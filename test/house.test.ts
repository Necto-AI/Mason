/**
 * `~/.mason` is the agent's home: a directory Denis can read, diff and revert. These tests pin the layout and the file
 * writes the rest of the server builds on — the paths, the one-time soul, the dated log — without ever touching the
 * real home: every home here is a temporary directory created for the test.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import {
	appendFact,
	capText,
	ensureHouse,
	ensureRepository,
	housePaths,
	logPathFor,
	readHouseFile,
} from "../src/server/house.ts";

const run = promisify(execFile);

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

test("housePaths() follows MASON_HOME and joins soul, profile, log and skills", async () => {
	const home = await tempDir("mason-house-paths-");
	const previous = process.env.MASON_HOME;
	process.env.MASON_HOME = home;
	try {
		assert.deepEqual(housePaths(), {
			home,
			soul: join(home, "soul.md"),
			profile: join(home, "profile.md"),
			logDir: join(home, "log"),
			skillsDir: join(home, "skills"),
			workspaceDir: join(home, "workspace"),
		});
	} finally {
		if (previous === undefined) delete process.env.MASON_HOME;
		else process.env.MASON_HOME = previous;
	}
});

test("logPathFor() names the file by the local date, not UTC", async () => {
	const paths = housePaths(await tempDir("mason-house-log-"));
	// The hours are local components: an instant built at 23:59 local stays on that day, and month and day are padded.
	assert.equal(logPathFor(paths, new Date(2026, 0, 5, 23, 59)), join(paths.logDir, "2026-01-05.md"));
	assert.equal(logPathFor(paths, new Date(2026, 11, 31, 0, 0)), join(paths.logDir, "2026-12-31.md"));
	assert.equal(logPathFor(paths, new Date(2026, 0, 6, 0, 0)), join(paths.logDir, "2026-01-06.md"));
});

test("a leading ~ in MASON_HOME is a home directory, not a directory named ~", () => {
	const previous = process.env.MASON_HOME;
	process.env.MASON_HOME = "~/mason-home-probe";
	try {
		const paths = housePaths();
		assert.equal(paths.home, join(homedir(), "mason-home-probe"));
		assert.equal(paths.soul, join(homedir(), "mason-home-probe", "soul.md"));
	} finally {
		if (previous === undefined) delete process.env.MASON_HOME;
		else process.env.MASON_HOME = previous;
	}
});

test("ensureHouse() creates log/, skills/ and the workspace the agent works in", async () => {
	const paths = housePaths(join(await tempDir("mason-house-ensure-"), "home"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");

	assert.ok((await stat(paths.logDir)).isDirectory(), "the log directory exists");
	assert.ok((await stat(paths.skillsDir)).isDirectory(), "the skills directory exists");
	assert.ok((await stat(paths.workspaceDir)).isDirectory(), "the agent has a workspace of its own");
	assert.equal((await readFile(paths.soul, "utf8")).trim(), "SOUL FROM THE PRODUCT");
});

test("ensureHouse() never overwrites an existing soul.md", async () => {
	const paths = housePaths(join(await tempDir("mason-house-soul-"), "home"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");

	// Denis's file, once it exists, is the source of truth: a restart must not put the default back.
	await writeFile(paths.soul, "Denis's own soul.\n", "utf8");
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	assert.equal(await readFile(paths.soul, "utf8"), "Denis's own soul.\n");
});

test("readHouseFile() is undefined for a missing or blank file, and trimmed text otherwise", async () => {
	const directory = await tempDir("mason-house-read-");
	assert.equal(await readHouseFile(join(directory, "missing.md")), undefined);

	const blank = join(directory, "blank.md");
	await writeFile(blank, "  \n\t\n\n", "utf8");
	assert.equal(await readHouseFile(blank), undefined);

	const filled = join(directory, "filled.md");
	await writeFile(filled, "  something worth keeping\n\n", "utf8");
	assert.equal(await readHouseFile(filled), "something worth keeping");
});

test("capText() leaves short text alone and truncates long text on a line boundary", () => {
	const short = "A short profile.";
	assert.equal(capText(short, 1000), short);
	assert.equal(capText(short, short.length), short, "exactly at the budget is within it");

	const long = ["line 1 of the profile", "line 2 of the profile", "line 3 of the profile"].join("\n");
	const capped = capText(long, 40);
	// The cut lands on the newline after line 1 rather than in the middle of line 2, so the prompt stays readable.
	assert.equal(capped, "line 1 of the profile\n\n(truncated at 40 characters)");
	assert.ok(capped.length < long.length);
});

test("appendFact() writes one dated line and reuses the day's heading", async () => {
	const paths = housePaths(await tempDir("mason-house-facts-"));
	const at = new Date(2026, 0, 5, 9, 7);

	const first = await appendFact(paths, "Denis prefers short answers.", at);
	assert.equal(first, logPathFor(paths, at), "the fact lands in today's file");
	assert.equal(await readFile(first, "utf8"), "# 2026-01-05\n\n- 09:07 — Denis prefers short answers.\n");

	// Whitespace in a fact collapses to one line: the log is one fact per line, or it is not greppable.
	const second = await appendFact(paths, "Standup\nmoved\tto  nine.", new Date(2026, 0, 5, 18, 2));
	assert.equal(second, first, "a second fact the same day reuses the file");
	const text = await readFile(second, "utf8");
	assert.equal((text.match(/^# /gm) ?? []).length, 1, "the heading is not duplicated");
	assert.equal((text.match(/^- /gm) ?? []).length, 2, "one line per fact");
	assert.match(text, /^- 09:07 — Denis prefers short answers\.$/m);
	assert.match(text, /^- 18:02 — Standup moved to nine\.$/m);
});

test("a remembered fact is committed, and only the log file is staged", async (t) => {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return;
	}
	const home = await tempDir("mason-house-commit-");
	await ensureRepository(home);
	const paths = housePaths(home);

	// Something else pending in the home, as Denis's own edit would be: it must not ride along in a memory commit.
	await writeFile(join(home, "soul.md"), "Denis's draft soul.\n", "utf8");

	const path = await appendFact(paths, "Budgets are reviewed on Fridays.", new Date(2026, 0, 5, 9, 7));
	const log = await run("git", ["log", "--oneline"], { cwd: home });
	assert.equal(log.stdout.trim().split("\n").length, 1, "one commit per fact");
	assert.match(log.stdout, /memory: Budgets are reviewed on Fridays/);
	const stat = await run("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: home });
	assert.equal(stat.stdout.trim(), path.slice(home.length + 1), "only the day's log is in the commit");
	const status = await run("git", ["status", "--porcelain"], { cwd: home });
	assert.match(status.stdout, /soul\.md/, "an unrelated edit stays pending");
});

test("two facts remembered at once both land", async () => {
	const paths = housePaths(await tempDir("mason-house-race-"));
	// Tool calls in one turn run concurrently: a read-modify-write of the day's file would drop one of these.
	await Promise.all([appendFact(paths, "first fact"), appendFact(paths, "second fact")]);
	const text = await readFile(logPathFor(paths), "utf8");
	assert.match(text, /first fact/);
	assert.match(text, /second fact/);
	assert.equal((text.match(/^# /gm) ?? []).length, 1, "one heading, even when both create the file");
});

test("ensureRepository() initialises the home as a git repository", async (t) => {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return;
	}
	const home = await tempDir("mason-house-git-");
	await ensureRepository(home);
	assert.ok(existsSync(join(home, ".git")), "a memory write is something Denis can revert");

	// Running it on every start must be harmless.
	await ensureRepository(home);
	assert.ok(existsSync(join(home, ".git")));
});

async function gitAvailable(): Promise<boolean> {
	try {
		await run("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}
