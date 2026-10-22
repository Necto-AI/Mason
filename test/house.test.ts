/**
 * `~/.mason` is the agent's home, in two halves: `agent/` (mounted into the tool machine, the agent's own files and its
 * history) and `service/` (the server's, never a path inside the tool machine). These tests pin the layout, the modes a
 * fresh install creates, the log write through the execution environment, and the migration that turns a home from
 * before the split into this one — without ever touching the real home: every home here is a temporary directory.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Connection, LocalExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import { daemonCommand } from "../src/server/env.ts";
import {
	appendFact,
	capText,
	ensureHouse,
	ensureRepository,
	housePaths,
	logPathFor,
	migrateHouse,
	readHouseFile,
} from "../src/server/house.ts";

const run = promisify(execFile);

const directories = new Set<string>();

/**
 * The tool machine, for the writes that happen there. `LocalExecutionEnv` is a real environment over a real `pi-env`
 * daemon: the same code path the deployment's SSH target takes, on one box.
 */
const connection = new Connection({ command: daemonCommand(localDaemon()) });
function toolMachine(cwd: string): LocalExecutionEnv {
	return new LocalExecutionEnv({ connection, cwd });
}

after(async () => {
	connection.close();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

test("housePaths() follows MASON_HOME and puts every path in one of the two halves", async () => {
	const home = await tempDir("mason-house-paths-");
	const previous = process.env.MASON_HOME;
	process.env.MASON_HOME = home;
	try {
		assert.deepEqual(housePaths(), {
			home,
			agentDir: join(home, "agent"),
			serviceDir: join(home, "service"),
			// The agent's half: its own files, on the volume the tool machine mounts.
			profile: join(home, "agent", "profile.md"),
			logDir: join(home, "agent", "log"),
			journalDir: join(home, "agent", "journal"),
			skillsDir: join(home, "agent", "skills"),
			agentsDir: join(home, "agent", "agents"),
			workspaceDir: join(home, "agent", "workspace"),
			// The server's half: the soul it renders, the door, the names, the keys and the state.
			soul: join(home, "service", "soul.md"),
			config: join(home, "service", "config.json"),
			roster: join(home, "service", "roster.json"),
			sshDir: join(home, "service", "ssh"),
			piDir: join(home, "service", "pi"),
			dataDir: join(home, "service", "data"),
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
		assert.equal(paths.soul, join(homedir(), "mason-home-probe", "service", "soul.md"));
	} finally {
		if (previous === undefined) delete process.env.MASON_HOME;
		else process.env.MASON_HOME = previous;
	}
});

test("ensureHouse() creates both halves, their directories and the modes they need", async () => {
	const paths = housePaths(join(await tempDir("mason-house-ensure-"), "home"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");

	for (const directory of [
		paths.agentDir,
		paths.logDir,
		paths.journalDir,
		paths.skillsDir,
		paths.agentsDir,
		paths.workspaceDir,
		paths.serviceDir,
		paths.dataDir,
		paths.sshDir,
		paths.piDir,
	]) {
		const info = await stat(directory);
		assert.ok(info.isDirectory(), `${directory} exists`);
		// 0700 on every directory of the home: it holds a transcript of everything Denis said.
		assert.equal(info.mode & 0o777, 0o700, `${directory} is private`);
	}
	assert.equal((await readFile(paths.soul, "utf8")).trim(), "SOUL FROM THE PRODUCT");
	assert.equal((await stat(paths.soul)).mode & 0o777, 0o600, "the soul is a private file");
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
	const home = await tempDir("mason-house-facts-");
	const paths = housePaths(home);
	const env = toolMachine(home);
	const at = new Date(2026, 0, 5, 9, 7);

	const first = await appendFact(env, paths, "Denis prefers short answers.", BACKGROUND_CONTEXT, at);
	assert.equal(first, logPathFor(paths, at), "the fact lands in today's file, in the agent's half");
	assert.ok(first.startsWith(paths.agentDir), "the log is a file the tool machine can see");
	assert.equal(await readFile(first, "utf8"), "# 2026-01-05\n\n- 09:07 — Denis prefers short answers.\n");

	// Whitespace in a fact collapses to one line: the log is one fact per line, or it is not greppable.
	const second = await appendFact(
		env,
		paths,
		"Standup\nmoved\tto  nine.",
		BACKGROUND_CONTEXT,
		new Date(2026, 0, 5, 18, 2),
	);
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
	const paths = housePaths(home);
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	// The repository the agent commits in: the one on its own half, which is the volume the tool machine mounts.
	await ensureRepository(paths.agentDir);
	const env = toolMachine(home);

	// Something else pending in the agent's half, as the agent's own edit would be: it must not ride along in a memory
	// commit, which is about one fact and nothing else.
	await writeFile(join(paths.agentDir, "profile.md"), "Denis's draft profile.\n", "utf8");

	const path = await appendFact(env, paths, "Budgets are reviewed on Fridays.", BACKGROUND_CONTEXT, new Date(2026, 0, 5, 9, 7));
	const log = await run("git", ["log", "--oneline"], { cwd: paths.agentDir });
	assert.equal(log.stdout.trim().split("\n").length, 1, "one commit per fact");
	assert.match(log.stdout, /memory: Budgets are reviewed on Fridays/);
	const stat = await run("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: paths.agentDir });
	assert.equal(stat.stdout.trim(), path.slice(paths.agentDir.length + 1), "only the day's log is in the commit");
	const status = await run("git", ["status", "--porcelain"], { cwd: paths.agentDir });
	assert.match(status.stdout, /profile\.md/, "an unrelated edit stays pending");
});

test("two facts remembered at once both land", async () => {
	const home = await tempDir("mason-house-race-");
	const paths = housePaths(home);
	const env = toolMachine(home);
	// Tool calls in one turn run concurrently: a read-modify-write of the day's file would drop one of these.
	await Promise.all([
		appendFact(env, paths, "first fact", BACKGROUND_CONTEXT),
		appendFact(env, paths, "second fact", BACKGROUND_CONTEXT),
	]);
	const text = await readFile(logPathFor(paths), "utf8");
	assert.match(text, /first fact/);
	assert.match(text, /second fact/);
	assert.equal((text.match(/^# /gm) ?? []).length, 1, "one heading, even when both create the file");
});

test("ensureRepository() initialises the agent's half as a git repository", async (t) => {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return;
	}
	const paths = housePaths(await tempDir("mason-house-git-"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	await ensureRepository(paths.agentDir);
	assert.ok(existsSync(join(paths.agentDir, ".git")), "a memory write is something Denis can revert");
	assert.ok(!existsSync(join(paths.home, ".git")), "and the history is on the half the tool machine mounts");

	// Running it on every start must be harmless.
	await ensureRepository(paths.agentDir);
	assert.ok(existsSync(join(paths.agentDir, ".git")));
});

/**
 * The migration: one command, two commits, and a home that is either moved or left exactly as it was.
 *
 * The fixture is a home from before the split: the soul, the profile, a day's log, the database and one file mason has
 * never heard of, all at the root of a git repository that has already committed a remembered fact.
 */
async function oldLayoutHome(t: { skip(reason: string): void }): Promise<string> {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return "";
	}
	const home = await tempDir("mason-house-migrate-");
	await mkdir(join(home, "log"), { recursive: true });
	await mkdir(join(home, "data"), { recursive: true });
	await mkdir(join(home, "skills", "weekly"), { recursive: true });
	await writeFile(join(home, "soul.md"), "You are SOUL-MARKER.\n", "utf8");
	await writeFile(join(home, "profile.md"), "Denis prefers short answers.\n", "utf8");
	await writeFile(join(home, "log", "2026-01-05.md"), "# 2026-01-05\n\n- 09:07 — Something remembered.\n", "utf8");
	await writeFile(join(home, "data", "agent.sqlite"), "not really a database", "utf8");
	await writeFile(join(home, "skills", "weekly", "SKILL.md"), "---\nname: weekly\ndescription: Write it.\n---\n", "utf8");
	// A file mason does not know about: an upgrade is not allowed to decide what happens to it.
	await writeFile(join(home, "NOTES.md"), "Denis's own notes.\n", "utf8");
	await run("git", ["init", "--quiet"], { cwd: home });
	await run("git", ["add", "-A"], { cwd: home });
	await run("git", ["-c", "user.name=denis", "-c", "user.email=d@example.com", "commit", "--quiet", "-m", "the home"], {
		cwd: home,
	});
	return home;
}

test("migrateHouse() moves an old home into its two halves and commits it in the home's own history", async (t) => {
	const home = await oldLayoutHome(t);
	if (home === "") return;
	const paths = housePaths(home);

	const outcome = await migrateHouse(paths);
	assert.equal(outcome.status, "moved");
	assert.ok(outcome.status === "moved" && outcome.committed, "the move is a commit Denis can read and revert");

	// The agent's half.
	assert.equal(await readFile(join(paths.agentDir, "profile.md"), "utf8"), "Denis prefers short answers.\n");
	assert.equal(
		await readFile(join(paths.logDir, "2026-01-05.md"), "utf8"),
		"# 2026-01-05\n\n- 09:07 — Something remembered.\n",
	);
	assert.ok(existsSync(join(paths.skillsDir, "weekly", "SKILL.md")), "skills moved with the files they instruct");
	assert.ok(existsSync(paths.workspaceDir), "the workspace is created even though the old home had none");
	// The server's half.
	assert.equal(await readFile(paths.soul, "utf8"), "You are SOUL-MARKER.\n");
	assert.ok(existsSync(join(paths.dataDir, "agent.sqlite")), "the state is in the half no tool can see");
	// And what mason does not know about stays where it was.
	assert.equal(await readFile(join(home, "NOTES.md"), "utf8"), "Denis's own notes.\n");
	for (const name of ["soul.md", "profile.md", "log", "data", "skills"]) {
		assert.ok(!existsSync(join(home, name)), `${name} is no longer at the root`);
	}

	// The repository moved with the files it is about, and both commits are in it: the move, then the service half
	// leaving. Nothing is left pending in `agent/`.
	assert.ok(existsSync(join(paths.agentDir, ".git")), "the history lives on the half the tool machine mounts");
	assert.ok(!existsSync(join(home, ".git")), "and the root is deliberately not a repository any more");
	const history = await run("git", ["log", "--format=%s"], { cwd: paths.agentDir });
	assert.deepEqual(history.stdout.trim().split("\n"), [
		"The service-owned files leave this repository",
		"Split the home into agent-owned and service-owned files",
		"the home",
	]);
	const status = await run("git", ["status", "--porcelain"], { cwd: paths.agentDir });
	assert.equal(status.stdout.trim(), "", "the migration leaves nothing half-done behind");
	// The move is a rename in the history, not a delete and an add.
	const rename = await run("git", ["show", "--name-status", "--format=", "HEAD~1"], { cwd: paths.agentDir });
	assert.match(rename.stdout, /^R100\tprofile\.md\tagent\/profile\.md$/m);
});

test("migrateHouse() is a no-op the second time", async (t) => {
	const home = await oldLayoutHome(t);
	if (home === "") return;
	const paths = housePaths(home);
	await migrateHouse(paths);

	const again = await migrateHouse(paths);
	assert.equal(again.status, "unchanged", "a half-finished move is not a state to reason about");
	const history = await run("git", ["log", "--format=%s"], { cwd: paths.agentDir });
	assert.equal(history.stdout.trim().split("\n").length, 3, "and it committed nothing the second time");
});

test("migrateHouse() refuses a home that has the same entry in both halves", async (t) => {
	const home = await oldLayoutHome(t);
	if (home === "") return;
	const paths = housePaths(home);
	// Two candidates for one file: a human did this, and only a human knows which one is real.
	await mkdir(paths.agentDir, { recursive: true });
	await writeFile(join(paths.agentDir, "profile.md"), "A different profile.\n", "utf8");

	const outcome = await migrateHouse(paths);
	assert.equal(outcome.status, "refused");
	assert.ok(outcome.status === "refused" && /both layouts are present/.test(outcome.reason));
	assert.ok(outcome.status === "refused" && /profile\.md/.test(outcome.reason), "it says which entry is ambiguous");
	assert.equal(await readFile(join(home, "profile.md"), "utf8"), "Denis prefers short answers.\n", "nothing moved");
});

async function gitAvailable(): Promise<boolean> {
	try {
		await run("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}
