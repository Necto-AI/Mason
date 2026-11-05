/**
 * `~/.mason` is the agent's home, in two halves: `agent/` (mounted into the tool machine, the agent's own files and its
 * history) and `service/` (the server's, never a path inside the tool machine). These tests pin the layout, the modes a
 * fresh install creates, the log write through the execution environment, and the migration that turns a home from
 * before the split into this one — without ever touching the real home: every home here is a temporary directory.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Connection, LocalExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import { daemonCommand } from "../src/server/env.ts";
import { discoverSkills, SHIPPED_SKILLS_DIR } from "../src/server/extensions/skills.ts";
import {
	appendFact,
	capText,
	ensureHouse,
	ensureRepository,
	HOUSE_ENTRIES,
	housePaths,
	logPathFor,
	migrateHouse,
	readHouseFile,
	seedShippedSkills,
} from "../src/server/house.ts";

const run = promisify(execFile);

/** The checkout these tests live in: `doctor` is a command, and a refusal has to reach it as an exit code. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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
			// The server's half: the soul it renders, the door, the keys and the state.
			soul: join(home, "service", "soul.md"),
			config: join(home, "service", "config.json"),
			// Later than the split: no home from before it has one, so no migration carries it.
			integrations: join(home, "service", "integrations.json"),
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

	const path = await appendFact(
		env,
		paths,
		"Budgets are reviewed on Fridays.",
		BACKGROUND_CONTEXT,
		new Date(2026, 0, 5, 9, 7),
	);
	// The repository arrives with one commit in it (the home's first files); the fact is the one after that.
	const log = await run("git", ["log", "--oneline"], { cwd: paths.agentDir });
	assert.equal(log.stdout.trim().split("\n").length, 2, "one commit per fact");
	assert.match(log.stdout.split("\n")[0] ?? "", /memory: Budgets are reviewed on Fridays/);
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

test("ensureRepository() initialises the agent's half as a git repository, with the first commit made", async (t) => {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return;
	}
	const paths = housePaths(await tempDir("mason-house-git-"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	await ensureRepository(paths.agentDir);
	assert.ok(existsSync(join(paths.agentDir, ".git")), "a memory write is something Denis can revert");
	assert.ok(!existsSync(join(paths.home, ".git")), "and the history is on the half the tool machine mounts");
	// A new home's files — the profile, the seeded skills — are its first memory, not untracked dirt forever.
	const history = await run("git", ["log", "--format=%s"], { cwd: paths.agentDir });
	assert.deepEqual(history.stdout.trim().split("\n"), ["The agent's memory starts here"]);
	const tracked = await run("git", ["ls-files"], { cwd: paths.agentDir });
	assert.match(tracked.stdout, /^\.gitignore$/m);
	assert.match(tracked.stdout, /^skills\/generative-ui\/SKILL\.md$/m, "the skills seeded at this boot are committed");
	assert.match(await readFile(join(paths.agentDir, ".gitignore"), "utf8"), /^workspace\/$/m);
	assert.equal((await run("git", ["status", "--porcelain"], { cwd: paths.agentDir })).stdout.trim(), "");

	// Running it on every start must be harmless.
	await ensureRepository(paths.agentDir);
	assert.ok(existsSync(join(paths.agentDir, ".git")));
	assert.equal(
		(await run("git", ["log", "--format=%s"], { cwd: paths.agentDir })).stdout.trim().split("\n").length,
		1,
	);
});

/**
 * The migration: one command, and a home that is either moved or left exactly as it was.
 *
 * The fixture is a home from before the split: the soul, the profile, a day's log, the database, the SSH key, the
 * pairing-token hashes and one file mason has never heard of, all at the root of a git repository that has already
 * committed them. The secret strings are planted so the tests can say the key and the token hashes never enter the
 * repository `agent/` becomes, which is the half the tool machine mounts.
 */
const SECRETS = {
	key: "SECRET-PRIVATE-KEY-3f9a",
	tokens: "SECRET-TOKEN-HASH-8c41",
	transcript: "SECRET-TRANSCRIPT-27be",
} as const;

async function oldLayoutHome(t: { skip(reason: string): void }): Promise<string> {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return "";
	}
	const home = await oldLayoutHomeWithoutGit();
	await run("git", ["init", "--quiet"], { cwd: home });
	await run("git", ["add", "-A"], { cwd: home });
	await run(
		"git",
		["-c", "user.name=denis", "-c", "user.email=d@example.com", "commit", "--quiet", "-m", "the home"],
		{
			cwd: home,
		},
	);
	return home;
}

/** The same home as a directory that is not a repository at all: mason's own state is not required to be under git. */
async function oldLayoutHomeWithoutGit(): Promise<string> {
	const home = await tempDir("mason-house-migrate-");
	await mkdir(join(home, "log"), { recursive: true });
	await mkdir(join(home, "data"), { recursive: true });
	await mkdir(join(home, "ssh"), { recursive: true });
	await mkdir(join(home, "pi"), { recursive: true });
	await mkdir(join(home, "skills", "weekly"), { recursive: true });
	await writeFile(join(home, "soul.md"), "You are SOUL-MARKER.\n", "utf8");
	await writeFile(join(home, "profile.md"), "Denis prefers short answers.\n", "utf8");
	await writeFile(join(home, "log", "2026-01-05.md"), "# 2026-01-05\n\n- 09:07 — Something remembered.\n", "utf8");
	await writeFile(join(home, "config.json"), JSON.stringify({ tokens: [{ sha256: SECRETS.tokens }] }), "utf8");
	await writeFile(join(home, "ssh", "id_ed25519"), `${SECRETS.key}\n`, "utf8");
	await writeFile(join(home, "data", "agent.sqlite"), SECRETS.transcript, "utf8");
	await writeFile(join(home, "pi", "auth.json"), '{"provider":{"type":"api_key","key":"k"}}\n', "utf8");
	await writeFile(
		join(home, "skills", "weekly", "SKILL.md"),
		"---\nname: weekly\ndescription: Write it.\n---\n",
		"utf8",
	);
	// A file mason does not know about: an upgrade is not allowed to decide what happens to it.
	await writeFile(join(home, "NOTES.md"), "Denis's own notes.\n", "utf8");
	return home;
}

/** Whether `path` is `root` or inside it: the question every repair instruction is held to. */
function inside(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

/** The `mv <from> <to>` a refusal hands an operator: a repair is a command they can run, so a test runs it. */
function instructionIn(reason: string): { from: string; to: string } {
	const match = /`mv (\S+) (\S+)`/.exec(reason);
	assert.ok(match, `the refusal names a move to run: ${reason}`);
	return { from: match[1] as string, to: match[2] as string };
}

/** Every file under `dir`, so a test can ask whether a secret is anywhere in a half and not merely uncommitted. */
async function filesUnder(dir: string): Promise<string[]> {
	const found: string[] = [];
	const pending = [dir];
	while (pending.length > 0) {
		const directory = pending.pop() as string;
		for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else found.push(path);
		}
	}
	return found;
}

/** The files a repository's every revision holds that contain `needle`: the history a tool machine can read. */
async function inHistory(dir: string, needle: string): Promise<string> {
	const revisions = (await run("git", ["rev-list", "--all"], { cwd: dir })).stdout.trim().split("\n");
	return run("git", ["grep", "-l", "--full-name", needle, ...revisions], { cwd: dir }).then(
		(result) => result.stdout.trim(),
		// `git grep` exits 1 when nothing matches, which is the answer these tests want.
		() => "",
	);
}

/**
 * The home the abandoned first version of the migration left behind: `agent/` is the home's only repository (there is
 * none at the root), and its history holds the service half. `withServiceFiles` keeps that version's layout exactly —
 * the key still sitting in `agent/service` — which is a different repair from the history, and a second refusal.
 */
async function abandonedFirstVersionHome(
	t: { skip(reason: string): void },
	options: { withServiceFiles?: boolean } = {},
): Promise<string> {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return "";
	}
	const home = await tempDir("mason-house-v1-");
	const paths = housePaths(home);
	await mkdir(paths.logDir, { recursive: true });
	await writeFile(paths.profile, "Denis prefers short answers.\n", "utf8");
	await writeFile(join(paths.logDir, "2026-01-05.md"), "# 2026-01-05\n\n- 09:07 — Something remembered.\n", "utf8");
	await mkdir(join(paths.agentDir, "service", "ssh"), { recursive: true });
	await writeFile(join(paths.agentDir, "service", "ssh", "id_ed25519"), `${SECRETS.key}\n`, "utf8");
	await writeFile(
		join(paths.agentDir, "service", "config.json"),
		JSON.stringify({ tokens: [{ sha256: SECRETS.tokens }] }),
		"utf8",
	);
	await run("git", ["init", "--quiet"], { cwd: paths.agentDir });
	await run("git", ["add", "-A"], { cwd: paths.agentDir });
	await run("git", ["-c", "user.name=denis", "-c", "user.email=d@example.com", "commit", "--quiet", "-m", "v1"], {
		cwd: paths.agentDir,
	});
	// Files moved back out of the half while the history still names them: the leak is in the repository, not the tree.
	if (!(options.withServiceFiles ?? true)) await rm(join(paths.agentDir, "service"), { recursive: true, force: true });
	return home;
}

test("migrateHouse() moves the halves apart, and no service path reaches the agent's repository", async (t) => {
	const home = await oldLayoutHome(t);
	if (home === "") return;
	const paths = housePaths(home);

	const outcome = await migrateHouse(paths);
	assert.equal(outcome.status, "moved");
	assert.ok(outcome.status === "moved" && outcome.committed, "the pre-split repository at the root is frozen");

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
	assert.ok(existsSync(join(paths.sshDir, "id_ed25519")), "and so is the key mason logs in with");
	// And what mason does not know about stays where it was.
	assert.equal(await readFile(join(home, "NOTES.md"), "utf8"), "Denis's own notes.\n");
	for (const name of ["soul.md", "profile.md", "log", "data", "ssh", "pi", "skills", "config.json"]) {
		assert.ok(!existsSync(join(home, name)), `${name} is no longer at the root`);
	}

	// The agent's own repository: created here, so its history begins at the migration and holds the agent's files only.
	const history = await run("git", ["log", "--format=%s"], { cwd: paths.agentDir });
	assert.deepEqual(history.stdout.trim().split("\n"), ["The agent's memory starts here"]);
	const status = await run("git", ["status", "--porcelain"], { cwd: paths.agentDir });
	assert.equal(status.stdout.trim(), "", "the migration leaves nothing half-done behind");

	// The boundary this change exists for: the half the tool machine mounts carries no path from the server's half.
	const names = await run("git", ["log", "--all", "--name-only", "--pretty="], { cwd: paths.agentDir });
	const servicePaths = names.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && (line.startsWith("service/") || line === "service"));
	assert.deepEqual(servicePaths, [], "no service path is in the agent's history");
	const revisions = (await run("git", ["rev-list", "--all"], { cwd: paths.agentDir })).stdout.trim().split("\n");
	for (const secret of Object.values(SECRETS)) {
		const found = await run("git", ["grep", "-l", secret, ...revisions], { cwd: paths.agentDir })
			.then((result) => result.stdout)
			.catch(() => "");
		assert.equal(found.trim(), "", `${secret} is not in the repository the tool machine mounts`);
	}
	assert.ok(!existsSync(join(paths.agentDir, "config.json")), "the token hashes are not in the agent's half");
	assert.ok(!existsSync(join(paths.agentDir, "ssh")), "and neither is the key");
	assert.ok(!existsSync(join(paths.agentDir, "data")), "and neither is the transcript");

	// The pre-split repository stays at the home root, on the server, and is frozen: it keeps its own history and it no
	// longer sees either half.
	assert.ok(existsSync(join(home, ".git")), "the old repository is where it was, on the server");
	const rootHistory = await run("git", ["log", "--format=%s"], { cwd: home });
	assert.deepEqual(rootHistory.stdout.trim().split("\n"), [
		"The halves are separate from this repository",
		"the home",
	]);
	assert.match(await readFile(join(home, ".gitignore"), "utf8"), /^agent\/$/m);
	assert.match(await readFile(join(home, ".gitignore"), "utf8"), /^service\/$/m);
	const rootStatus = await run("git", ["status", "--porcelain"], { cwd: home });
	assert.equal(rootStatus.stdout.trim(), "", "the root is not dirt the agent's writes keep sweeping back into");
	// It still holds what it held: this repository is the server's, and it never reaches the tool machine.
	const kept = await run("git", ["show", `HEAD~1:ssh/id_ed25519`], { cwd: home });
	assert.match(kept.stdout, new RegExp(SECRETS.key), "the pre-split history is untouched where it stands");
});

test("migrateHouse() is a no-op the second time", async (t) => {
	const home = await oldLayoutHome(t);
	if (home === "") return;
	const paths = housePaths(home);
	await migrateHouse(paths);

	const again = await migrateHouse(paths);
	assert.equal(again.status, "unchanged", "a half-finished move is not a state to reason about");
	assert.deepEqual(
		again.status === "unchanged" ? again.finished : ["not unchanged"],
		[],
		"a finished home has nothing left to finish, so nothing is written",
	);
	const history = await run("git", ["log", "--format=%s"], { cwd: paths.agentDir });
	assert.equal(history.stdout.trim().split("\n").length, 1, "and it committed nothing the second time");
	const root = await run("git", ["log", "--format=%s"], { cwd: home });
	assert.equal(root.stdout.trim().split("\n").length, 2, "nor did the frozen repository at the root");
});

/**
 * The state a migration that died after its move loop leaves: both halves populated, nothing at the root — and none of
 * the tail, so `workspace/` is not ignored, `agent/.git` has no HEAD and the repository at the root still holds both
 * halves. Every rerun used to answer `unchanged` over it.
 */
async function interruptedMigration(t: { skip(reason: string): void }): Promise<string> {
	const home = await oldLayoutHome(t);
	if (home === "") return "";
	for (const entry of HOUSE_ENTRIES) {
		const from = join(home, entry.name);
		if (!existsSync(from)) continue;
		const half = join(home, entry.half);
		await mkdir(half, { recursive: true });
		await rename(from, join(half, entry.name));
	}
	return home;
}

test("migrateHouse() finishes the tail an interrupted migration left", async (t) => {
	const home = await interruptedMigration(t);
	if (home === "") return;
	const paths = housePaths(home);
	// The boot after the interruption: `git init` in `agent/` and nothing else, so the repository has no HEAD.
	await run("git", ["init", "--quiet"], { cwd: paths.agentDir });

	const outcome = await migrateHouse(paths);
	assert.equal(outcome.status, "unchanged", "there is nothing left to move");
	assert.deepEqual(outcome.status === "unchanged" ? outcome.finished.length : 0, 2, "and it says what it finished");

	// The agent's half: a HEAD, the files committed, the workspace out of it.
	const agentLog = await run("git", ["log", "--format=%s"], { cwd: paths.agentDir });
	assert.deepEqual(agentLog.stdout.trim().split("\n"), ["The agent's memory starts here"]);
	assert.match(await readFile(join(paths.agentDir, ".gitignore"), "utf8"), /^workspace\/$/m);
	assert.equal((await run("git", ["status", "--porcelain"], { cwd: paths.agentDir })).stdout.trim(), "");
	const tracked = await run("git", ["ls-files"], { cwd: paths.agentDir });
	assert.match(tracked.stdout, /^profile\.md$/m, "the agent's existing files are in its history");
	assert.doesNotMatch(tracked.stdout, /^service\//m);

	// The repository at the root: frozen, rather than still holding both halves.
	assert.match(await readFile(join(home, ".gitignore"), "utf8"), /^agent\/$/m);
	assert.match(await readFile(join(home, ".gitignore"), "utf8"), /^service\/$/m);
	const rootLog = await run("git", ["log", "--format=%s"], { cwd: home });
	assert.deepEqual(rootLog.stdout.trim().split("\n"), ["The halves are separate from this repository", "the home"]);
	assert.equal((await run("git", ["status", "--porcelain"], { cwd: home })).stdout.trim(), "");

	// And now it is genuinely finished, so a third run writes nothing at all.
	const again = await migrateHouse(paths);
	assert.deepEqual(again.status === "unchanged" ? again.finished : ["not unchanged"], []);
});

test("migrateHouse() reports only the freeze it actually committed", async (t) => {
	const home = await interruptedMigration(t);
	if (home === "") return;
	const paths = housePaths(home);
	// git refuses the freeze for a reason no argument can fix, so nothing was frozen and nothing may be reported as done.
	await writeFile(join(home, ".git", "index.lock"), "", "utf8");

	const outcome = await migrateHouse(paths);
	assert.equal(outcome.status, "unchanged");
	assert.deepEqual(
		outcome.status === "unchanged" ? outcome.finished : ["not unchanged"],
		[`the agent's first commit in ${join(paths.agentDir, ".git")}`],
		"the agent's history, and not a freeze that did not happen",
	);
	assert.doesNotMatch(await readFile(join(home, ".gitignore"), "utf8").catch(() => ""), /^agent\/$/m);
});

test("migrateHouse() on a home with no agent half finishes nothing and does not throw", async () => {
	const paths = housePaths(join(await tempDir("mason-house-empty-"), "home"));
	// The tail used to write `agent/.gitignore` into a directory that was not there: `doctor -- migrate` died on ENOENT.
	const outcome = await migrateHouse(paths);
	assert.equal(outcome.status, "unchanged");
	assert.deepEqual(
		outcome.status === "unchanged" ? outcome.finished : ["not unchanged"],
		[],
		"there was no history to make, so none is reported",
	);
	assert.ok(!existsSync(paths.agentDir), "and nothing was created");
});

test("migrateHouse() starts the agent's repository when an interruption left none", async (t) => {
	const home = await interruptedMigration(t);
	if (home === "") return;
	const paths = housePaths(home);
	// Died between the move loop and the tail, before any boot: `agent/` holds the files and no repository. The home
	// root is a repository, and `git` walks up, so this is the case where the agent's half could be mistaken for one.
	assert.ok(!existsSync(join(paths.agentDir, ".git")));

	const outcome = await migrateHouse(paths);
	assert.equal(outcome.status, "unchanged");
	assert.deepEqual(outcome.status === "unchanged" ? outcome.finished.length : 0, 2);

	const agentLog = await run("git", ["log", "--format=%s"], { cwd: paths.agentDir });
	assert.deepEqual(agentLog.stdout.trim().split("\n"), ["The agent's memory starts here"], "a history of its own");
	const tracked = await run("git", ["ls-files"], { cwd: paths.agentDir });
	assert.doesNotMatch(tracked.stdout, /^service\//m, "and not the root repository's history under another name");
	assert.equal((await run("git", ["status", "--porcelain"], { cwd: home })).stdout.trim(), "", "the root is frozen");
});

test("migrateHouse() refuses a history that already holds the service half", async (t) => {
	const home = await oldLayoutHome(t);
	if (home === "") return;
	const paths = housePaths(home);
	await migrateHouse(paths);
	// The abandoned first version of the migration: the service entries moved *into* `agent/` and were committed there,
	// so the one history the tool machine mounts holds the token hashes and the key. It knew no `.gitignore`.
	await rm(join(paths.agentDir, ".git"), { recursive: true, force: true });
	await rm(join(paths.agentDir, ".gitignore"), { force: true });
	await mkdir(join(paths.agentDir, "service", "ssh"), { recursive: true });
	await writeFile(
		join(paths.agentDir, "service", "config.json"),
		JSON.stringify({ tokens: [{ sha256: SECRETS.tokens }] }),
		"utf8",
	);
	await writeFile(join(paths.agentDir, "service", "ssh", "id_ed25519"), `${SECRETS.key}\n`, "utf8");
	await run("git", ["init", "--quiet"], { cwd: paths.agentDir });
	await run("git", ["add", "-A"], { cwd: paths.agentDir });
	await run("git", ["-c", "user.name=denis", "-c", "user.email=d@example.com", "commit", "--quiet", "-m", "v1"], {
		cwd: paths.agentDir,
	});

	const outcome = await migrateHouse(paths);
	assert.equal(outcome.status, "refused", "a green light here is the exact state this change exists to prevent");
	const reason = outcome.status === "refused" ? outcome.reason : "";
	assert.match(reason, /predates this fix/, "it says why the home cannot be trusted as it stands");
	assert.match(reason, /service\/config\.json/, "and names what it found in the history");
	const repair = instructionIn(reason);
	assert.equal(repair.from, join(paths.agentDir, ".git"), "the repair moves the repository itself");
	assert.ok(!inside(repair.to, home), `the tainted history goes outside the home, not into a half: ${repair.to}`);
	assert.ok(!inside(repair.to, paths.agentDir), "and never into the half the tool machine mounts");
	assert.match(reason, /run this again/, "then run the command again");
	// The files are what matter, and nothing here touches them.
	assert.ok(existsSync(join(paths.agentDir, "service", "config.json")));
	assert.equal(await readFile(join(paths.agentDir, "profile.md"), "utf8"), "Denis prefers short answers.\n");

	// `doctor` is the command an operator actually runs on this home: a refusal has to be an exit code, not a sentence.
	const doctor = await run(process.execPath, ["--experimental-strip-types", "scripts/doctor.ts", "migrate"], {
		cwd: REPO_ROOT,
		env: { ...process.env, MASON_HOME: home },
	}).then(
		(result) => ({ code: 0, stderr: result.stderr }),
		(error: { code: number; stdout: string; stderr: string }) => error,
	);
	assert.notEqual(doctor.code, 0, "doctor keeps a non-zero exit on a refusal");
	assert.match(doctor.stderr, /predates this fix/, "and prints the reason rather than a stack trace");
});

test("doctor -- migrate stamps grants on a credential that predates them, once", async () => {
	// The home is already split — the layout needs nothing — so this is the half of the migration the panel added:
	// a config.json written before a device had grants. Running the command an operator runs is the whole point.
	const home = await tempDir("mason-house-grants-");
	const paths = housePaths(home);
	await mkdir(paths.serviceDir, { recursive: true, mode: 0o700 });
	await writeFile(
		paths.config,
		JSON.stringify({
			tokens: [
				{
					id: "tok_0ld",
					label: "browser",
					sha256: "a".repeat(64),
					createdAt: "2026-01-01T00:00:00.000Z",
				},
				{
					id: "tok_n3w",
					label: "phone",
					sha256: "b".repeat(64),
					createdAt: "2026-02-01T00:00:00.000Z",
					grants: ["conversation"],
				},
			],
			sessionKey: "s".repeat(43),
		}),
		"utf8",
	);
	const doctor = async () => {
		try {
			const result = await run(process.execPath, ["--experimental-strip-types", "scripts/doctor.ts", "migrate"], {
				cwd: REPO_ROOT,
				env: { ...process.env, MASON_HOME: home },
			});
			return { code: 0, stdout: result.stdout };
		} catch (error) {
			const failure = error as { code: number; stdout: string };
			return { code: failure.code, stdout: failure.stdout };
		}
	};
	const first = await doctor();
	assert.equal(first.code, 0, "an old credential is not a refusal");
	assert.match(first.stdout, /tok_0ld \(browser\) had no grants: stamped conversation, admin, approve/);
	const config = JSON.parse(await readFile(paths.config, "utf8")) as {
		tokens: { id: string; grants?: string[] }[];
	};
	const byId = new Map(config.tokens.map((record) => [record.id, record]));
	assert.deepEqual(byId.get("tok_0ld")?.grants, ["conversation", "admin", "approve"]);
	assert.deepEqual(byId.get("tok_n3w")?.grants, ["conversation"], "a narrowed device stays narrowed");

	// The second run is the same command on a home that has caught up: nothing is printed, nothing is written.
	const before = await readFile(paths.config, "utf8");
	const second = await doctor();
	assert.equal(second.code, 0);
	assert.doesNotMatch(second.stdout, /stamped/);
	assert.equal(await readFile(paths.config, "utf8"), before);
});

test("migrateHouse() repairs a home whose tainted history is moved out of it, and the key stays gone", async (t) => {
	// The history holds the service half; the files are already out of `agent/`, so the repository is the whole problem.
	const home = await abandonedFirstVersionHome(t, { withServiceFiles: false });
	if (home === "") return;
	const paths = housePaths(home);

	const refused = await migrateHouse(paths);
	assert.equal(refused.status, "refused");
	// The instruction is the repair: run it, verbatim, the way an operator would.
	const repair = instructionIn(refused.status === "refused" ? refused.reason : "");
	assert.equal(repair.from, join(paths.agentDir, ".git"));
	await rename(repair.from, repair.to);
	assert.ok(!existsSync(join(paths.agentDir, ".git")), "the repository is out of the half the tool machine mounts");
	assert.ok(!inside(repair.to, home), "and it went outside the home, not beside the files it came from");
	assert.deepEqual(
		(await readdir(paths.agentDir)).filter((name) => name === ".git" || name.startsWith(".git.")),
		[],
		"and the half holds no repository at all until the next run makes one",
	);

	const again = await migrateHouse(paths);
	assert.equal(again.status, "unchanged");
	// The repository was moved out, so this is the run that makes the agent's history — the one thing it finished.
	assert.deepEqual(again.status === "unchanged" ? again.finished : ["not unchanged"], [
		`the agent's first commit in ${join(paths.agentDir, ".git")}`,
	]);
	// The abandoned version had relocated the repository, so there is nothing at the root: the migration invents none.
	assert.ok(!existsSync(join(home, ".git")), "no repository at the home root, before or after");

	// What the half holds now: the agent's files and its own repository, and no copy of the tainted one under a name.
	assert.deepEqual(
		(await readdir(paths.agentDir)).filter((name) => name === ".git" || name.startsWith(".git.")),
		[".git"],
		"the only repository in the half is the agent's own",
	);
	const tracked = (await run("git", ["ls-files"], { cwd: paths.agentDir })).stdout.split("\n").filter(Boolean);
	assert.deepEqual(
		tracked.filter((path) => path === "service" || path.startsWith("service/")),
		[],
		"no service path",
	);
	assert.deepEqual(
		tracked.filter((path) => path.startsWith(".git")),
		[".gitignore"],
		"and no repository committed as files",
	);
	assert.deepEqual(
		(await run("git", ["log", "--format=%s"], { cwd: paths.agentDir })).stdout.trim().split("\n"),
		["The agent's memory starts here"],
		"the history begins here, not in the history that was moved out",
	);

	// The key: not in any revision of the half, and not a file in it either.
	assert.equal(await inHistory(paths.agentDir, SECRETS.key), "", "no revision holds the key");
	assert.equal(await inHistory(paths.agentDir, SECRETS.tokens), "", "nor the token hashes");
	for (const path of await filesUnder(paths.agentDir)) {
		assert.ok(!(await readFile(path, "utf8").catch(() => "")).includes(SECRETS.key), `${path} holds no key`);
	}

	// A correct home from here on: the third run writes nothing.
	const third = await migrateHouse(paths);
	assert.deepEqual(third.status === "unchanged" ? third.finished : ["not unchanged"], []);
});

test("migrateHouse() refuses the service files left in the agent's half, and moving them back finishes it", async (t) => {
	// The abandoned version's layout exactly: the history was moved out, and the files it committed are still in it.
	const home = await abandonedFirstVersionHome(t);
	if (home === "") return;
	const paths = housePaths(home);

	const tainted = await migrateHouse(paths);
	assert.equal(tainted.status, "refused");
	const repair = instructionIn(tainted.status === "refused" ? tainted.reason : "");
	await rename(repair.from, repair.to);
	assert.ok(!inside(repair.to, home), "the history is out of the home");

	const leaked = await migrateHouse(paths);
	assert.equal(leaked.status, "refused", "a `service/` path in the agent's half is refused, never committed");
	const reason = leaked.status === "refused" ? leaked.reason : "";
	assert.ok(reason.includes(join(paths.agentDir, "service")), `it names the path: ${reason}`);
	assert.ok(reason.includes(paths.serviceDir), "and where a service-owned file belongs");
	assert.match(reason, /run this again/, "then run the command again");
	assert.ok(!existsSync(join(paths.agentDir, ".git")), "so nothing was committed on the way");
	assert.equal(
		await readFile(join(paths.agentDir, "service", "ssh", "id_ed25519"), "utf8"),
		`${SECRETS.key}\n`,
		"and the files are untouched",
	);

	// The repair it names: the server's half is where those files belong.
	await rename(join(paths.agentDir, "service"), paths.serviceDir);
	const finished = await migrateHouse(paths);
	assert.equal(finished.status, "unchanged");
	assert.deepEqual(finished.status === "unchanged" ? finished.finished : ["not unchanged"], [
		`the agent's first commit in ${join(paths.agentDir, ".git")}`,
	]);
	// The key is in the half no tool sees, and nowhere in the half one does.
	assert.equal(await readFile(join(paths.serviceDir, "ssh", "id_ed25519"), "utf8"), `${SECRETS.key}\n`);
	assert.equal(await inHistory(paths.agentDir, SECRETS.key), "");
	for (const path of await filesUnder(paths.agentDir)) {
		assert.ok(!(await readFile(path, "utf8").catch(() => "")).includes(SECRETS.key), `${path} holds no key`);
	}
});

test("migrateHouse() and boot refuse a repository copy parked beside the agent's own", async (t) => {
	const home = await oldLayoutHome(t);
	if (home === "") return;
	const paths = housePaths(home);
	await migrateHouse(paths);
	// The shape the first repair instruction produced: the tainted history moved aside *within* the mounted volume.
	await mkdir(join(paths.agentDir, ".git.old"), { recursive: true });
	await writeFile(join(paths.agentDir, ".git.old", "HEAD"), "ref: refs/heads/main\n", "utf8");

	const outcome = await migrateHouse(paths);
	assert.equal(outcome.status, "refused", "ignoring it would leave the key readable in the volume");
	const reason = outcome.status === "refused" ? outcome.reason : "";
	assert.ok(reason.includes(join(paths.agentDir, ".git.old")), `it names the path: ${reason}`);
	assert.ok(!inside(instructionIn(reason).to, home), "and the same destination outside the home");
	await assert.rejects(
		() => ensureRepository(paths.agentDir),
		(error: Error) => {
			assert.ok(error.message.includes(join(paths.agentDir, ".git.old")), "boot refuses the same path");
			return true;
		},
	);

	// A checked-out repository in the workspace is the same problem under another name: `.git` below the top level.
	await rm(join(paths.agentDir, ".git.old"), { recursive: true, force: true });
	await mkdir(join(paths.workspaceDir, "checkout", ".git"), { recursive: true });
	await writeFile(join(paths.workspaceDir, "checkout", ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
	await assert.rejects(() => ensureRepository(paths.agentDir), /checkout\/\.git/);
});

test("ensureRepository() refuses a service path in the agent's half, and creates no repository", async (t) => {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return;
	}
	const paths = housePaths(await tempDir("mason-house-leak-"));
	await mkdir(join(paths.agentDir, "service", "ssh"), { recursive: true });
	await writeFile(join(paths.agentDir, "service", "ssh", "id_ed25519"), `${SECRETS.key}\n`, "utf8");

	await assert.rejects(
		() => ensureRepository(paths.agentDir),
		(error: Error) => {
			assert.ok(error.message.includes(join(paths.agentDir, "service")), `it names the path: ${error.message}`);
			assert.ok(error.message.includes(paths.serviceDir), "and the half those files belong to");
			return true;
		},
	);
	// Boot fails loudly *before* `git init` and before any staging, because a history with the key in it cannot be undone.
	assert.ok(!existsSync(join(paths.agentDir, ".git")), "no repository was created");
	assert.ok(!existsSync(join(paths.agentDir, ".gitignore")), "and nothing was staged");
	assert.equal(await readFile(join(paths.agentDir, "service", "ssh", "id_ed25519"), "utf8"), `${SECRETS.key}\n`);
});

test("a correct home is unchanged twice, with nothing to finish, and boots", async (t) => {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return;
	}
	const paths = housePaths(join(await tempDir("mason-house-correct-"), "home"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	await ensureRepository(paths.agentDir);

	for (const attempt of ["first", "second"]) {
		const outcome = await migrateHouse(paths);
		assert.equal(outcome.status, "unchanged", `${attempt} run: there is nothing to move`);
		assert.deepEqual(
			outcome.status === "unchanged" ? outcome.finished : ["not unchanged"],
			[],
			`${attempt} run finishes nothing`,
		);
	}
	// And boot on it is still boot: the repository it already has, and nothing written over it.
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	await ensureRepository(paths.agentDir);
	assert.deepEqual((await run("git", ["log", "--format=%s"], { cwd: paths.agentDir })).stdout.trim().split("\n"), [
		"The agent's memory starts here",
	]);
	assert.equal((await run("git", ["status", "--porcelain"], { cwd: paths.agentDir })).stdout.trim(), "");
});

test("migrateHouse() does not claim it froze a repository it could not commit to", async (t) => {
	const home = await oldLayoutHome(t);
	if (home === "") return;
	const paths = housePaths(home);
	// A locked index is git refusing for a reason no identity argument can fix: `commitAt` swallows it, and the outcome
	// used to say `committed: true` anyway.
	await writeFile(join(home, ".git", "index.lock"), "", "utf8");

	const outcome = await migrateHouse(paths);
	assert.equal(outcome.status, "moved");
	assert.ok(outcome.status === "moved" && !outcome.committed, "the outcome reports the truth: nothing was committed");
	assert.equal(await readFile(join(paths.agentDir, "profile.md"), "utf8"), "Denis prefers short answers.\n");
	// The agent's own history is a different repository, and it is started either way.
	const agentLog = await run("git", ["log", "--format=%s"], { cwd: paths.agentDir });
	assert.deepEqual(agentLog.stdout.trim().split("\n"), ["The agent's memory starts here"]);
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

test("migrateHouse() accepts a half-created layout whose destination is empty", async (t) => {
	const home = await oldLayoutHome(t);
	if (home === "") return;
	const paths = housePaths(home);
	// A boot before the check wrote part of the new layout: an empty `agent/log` is a directory nobody put a fact in,
	// not a second candidate for the log at the root.
	await mkdir(paths.logDir, { recursive: true });

	const outcome = await migrateHouse(paths);
	assert.equal(outcome.status, "moved");
	assert.equal(
		await readFile(join(paths.logDir, "2026-01-05.md"), "utf8"),
		"# 2026-01-05\n\n- 09:07 — Something remembered.\n",
		"the log landed in the half, not inside the empty directory that was already there",
	);
	assert.ok(!existsSync(join(paths.logDir, "log")), "and the move did not nest the log inside itself");
});

test("migrateHouse() works on a home that is not a repository", async (t) => {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return;
	}
	const home = await oldLayoutHomeWithoutGit();
	const paths = housePaths(home);

	const outcome = await migrateHouse(paths);
	assert.equal(outcome.status, "moved");
	assert.ok(outcome.status === "moved" && !outcome.committed, "there was no repository at the root to freeze");
	assert.ok(!existsSync(join(home, ".git")), "and none was invented there");
	assert.equal(await readFile(paths.soul, "utf8"), "You are SOUL-MARKER.\n");
	assert.ok(existsSync(join(paths.dataDir, "agent.sqlite")));
	// The agent's history is started either way: it is the agent's, not the old home's.
	const history = await run("git", ["log", "--format=%s"], { cwd: paths.agentDir });
	assert.deepEqual(history.stdout.trim().split("\n"), ["The agent's memory starts here"]);
});

test("migrateHouse() keeps the agent's workspace out of the agent's history", async (t) => {
	const home = await oldLayoutHome(t);
	if (home === "") return;
	const paths = housePaths(home);
	await migrateHouse(paths);
	// The directory the agent works in is scratch: a file a tool leaves there is not a memory, and must not become one.
	await writeFile(join(paths.workspaceDir, "scratch.md"), "half-finished work\n", "utf8");
	const status = await run("git", ["status", "--porcelain"], { cwd: paths.agentDir });
	assert.equal(status.stdout.trim(), "", "a file in workspace/ is not dirt in the memory repo");
	assert.match(await readFile(join(paths.agentDir, ".gitignore"), "utf8"), /^workspace\/$/m);
});

test("a home from before the split is not opened: boot refuses it and creates nothing", async () => {
	const home = await oldLayoutHomeWithoutGit();
	const before = (await readdir(home)).sort();
	const paths = housePaths(home);

	await assert.rejects(
		() => ensureHouse(paths, "SOUL FROM THE PRODUCT"),
		/npm run doctor -- migrate/,
		"the error names the one command that moves the home",
	);
	assert.deepEqual((await readdir(home)).sort(), before, "and nothing at all was created");
	assert.ok(!existsSync(paths.agentDir), "not the agent's half");
	assert.ok(!existsSync(paths.serviceDir), "not the server's half");
	assert.ok(!existsSync(join(home, ".gitignore")), "not a .gitignore");
	assert.equal(await readFile(join(home, "soul.md"), "utf8"), "You are SOUL-MARKER.\n", "and the soul is untouched");
});

test("the same home boots once it has been migrated", async (t) => {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return;
	}
	const home = await oldLayoutHomeWithoutGit();
	const paths = housePaths(home);
	await migrateHouse(paths);

	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	assert.equal(await readFile(paths.soul, "utf8"), "You are SOUL-MARKER.\n", "boot does not replace Denis's soul");
	assert.equal(await readFile(join(paths.agentDir, "profile.md"), "utf8"), "Denis prefers short answers.\n");
});

test("ensureHouse() seeds the skills mason ships into the agent's half, and records what it seeded", async () => {
	const paths = housePaths(join(await tempDir("mason-house-seed-"), "home"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	const seeded = join(paths.skillsDir, "generative-ui", "SKILL.md");
	assert.ok(existsSync(seeded), "the shipped skill is in the home, which is what the tool machine has");
	const index = await discoverSkills(toolMachine(paths.home), [paths.skillsDir], BACKGROUND_CONTEXT);
	assert.ok(
		index.some((skill) => skill.name === "generative-ui"),
		"and the index lists it, so the prompt's pointer is not pointing at nothing",
	);

	// The record of what was copied lives in the server's half, where neither a tool nor the skills scan can reach it.
	const record = join(paths.dataDir, "seeded-skills.json");
	assert.ok(record.startsWith(paths.serviceDir), "the record is in the half the agent cannot see");
	assert.ok(!record.startsWith(paths.agentDir), "and never in the half the tool machine mounts");
	const recorded = JSON.parse(await readFile(record, "utf8")) as Record<string, string>;
	// One entry per skill the repository ships, whatever that set is today: this test is about the record, not a
	// catalogue of the manuals.
	assert.deepEqual(
		Object.keys(recorded).sort(),
		(await readdir(SHIPPED_SKILLS_DIR)).sort(),
		"one entry per shipped skill",
	);
	assert.equal(
		recorded["generative-ui"],
		createHash("sha256")
			.update(await readFile(seeded))
			.digest("hex"),
		"the hash of the file that was copied, which is how an upgrade knows the copy is still ours",
	);
	assert.ok(!index.some((skill) => skill.filePath.endsWith("seeded-skills.json")), "it is not a skill the scan finds");
	assert.ok(!(await readdir(paths.skillsDir)).includes("seeded-skills.json"));
});

/**
 * A shipped skill is a manual the renderer depends on, so an upgrade has to reach a home that already has a copy —
 * while a copy somebody edited has to survive the same boot. `shippedDir` stands in for the repository's `skills/` so
 * one home can see two editions of the same skill.
 */
test("a shipped skill follows the shipped copy, and an edited copy is never touched", async () => {
	const paths = housePaths(join(await tempDir("mason-house-seed-upgrade-"), "home"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	const copy = join(paths.skillsDir, "generative-ui", "SKILL.md");

	const shipped = await tempDir("mason-house-shipped-");
	await mkdir(join(shipped, "generative-ui"), { recursive: true });
	await writeFile(
		join(shipped, "generative-ui", "SKILL.md"),
		"---\nname: generative-ui\ndescription: The widget manual, first edition.\n---\n",
		"utf8",
	);
	await seedShippedSkills(paths, shipped);
	assert.match(await readFile(copy, "utf8"), /first edition/, "an unedited copy is replaced by the shipped one");

	// The next release of the same skill: nobody edited the home's copy, so it follows.
	await writeFile(
		join(shipped, "generative-ui", "SKILL.md"),
		"---\nname: generative-ui\ndescription: The widget manual, second edition.\n---\n",
		"utf8",
	);
	await seedShippedSkills(paths, shipped);
	assert.match(await readFile(copy, "utf8"), /second edition/, "an upgrade reaches a home that already booted");

	// Denis's own copy of the same skill: the hash no longer matches the record, so seeding leaves it alone.
	await writeFile(copy, "---\nname: generative-ui\ndescription: Denis's own widget notes.\n---\n", "utf8");
	await writeFile(
		join(shipped, "generative-ui", "SKILL.md"),
		"---\nname: generative-ui\ndescription: The widget manual, third edition.\n---\n",
		"utf8",
	);
	await seedShippedSkills(paths, shipped);
	assert.match(await readFile(copy, "utf8"), /Denis's own widget notes/, "an edited copy is theirs, upgrade or not");
});

async function gitAvailable(): Promise<boolean> {
	try {
		await run("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}
