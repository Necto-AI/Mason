/**
 * `~/.mason/` — everything the agent is made of, in two halves.
 *
 * The pattern: the agent's identity and memory are files Denis can read, diff and revert, not rows in a database he
 * cannot type into. This module owns the layout and the paths; nothing else in the server builds one by hand.
 *
 * ```text
 * ~/.mason/
 * ├── agent/                  # everything the agent owns: mounted into the tool machine, same absolute path
 * │   ├── profile.md          # who Denis is, agent-managed, always in the prompt
 * │   ├── log/2026-10-20.md   # dated facts, one per line, appended through the execution environment
 * │   ├── journal/            # where the daily journal will be written
 * │   ├── skills/<name>/SKILL.md
 * │   ├── agents/             # worker definitions; they sit beside skills so `write` can edit them
 * │   └── workspace/          # the directory the agent works in, separate from the code that runs it
 * └── service/                # everything the server owns: never a path inside the tool machine
 *     ├── soul.md             # the first section of the system prompt, supplied by the operator
 *     ├── config.json         # the token hashes and the session key (`auth.ts`)
 *     ├── roster.json         # who is in the room (`roster.ts`)
 *     ├── ssh/                # the key mason logs into the env machine with
 *     ├── pi/                 # the copy of the provider credential
 *     └── data/               # agent.sqlite, hooks.json, connectors.json
 * ```
 *
 * The split is a mount boundary, not a permission mode: `bash` can talk its way around a mode. `agent/` is one volume
 * mounted at the same absolute path in the server and in the tool machine, so a path the server sends as a tool's cwd
 * and a path the agent reads are the same string; `service/` is a second volume mounted only in the server, so the bot
 * cannot read its own door, its own keys or its own credential.
 *
 * `agent/` is also the home's git repository (`agent/.git`): its files are the ones the history is about, and the agent
 * commits to it from the tool machine with ordinary `git`. `service/` is deliberately unversioned.
 *
 * A home that predates the split is *not* opened by the server: its entries sit at the root, and booting it would write
 * the new layout on top of them and lose the soul and the profile to the defaults. `npm run doctor -- migrate` is the
 * one command that moves it, and `migrateHouse` refuses to do anything else.
 *
 * The home is `0700`, files in it `0600`: it holds a transcript of everything Denis said, which is not a thing to leave
 * readable by every other account on the machine.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

const run = promisify(execFile);

export interface HousePaths {
	/** The root: `MASON_HOME`, else `~/.mason`. Two halves hang below it. */
	readonly home: string;
	/** The half the agent owns and the tool machine sees: the home's repository lives here. */
	readonly agentDir: string;
	/** The half the server owns and no tool ever sees. */
	readonly serviceDir: string;
	readonly soul: string;
	readonly profile: string;
	readonly logDir: string;
	readonly journalDir: string;
	readonly skillsDir: string;
	/** Where worker definitions live, beside skills: a file the agent may edit with `write`. */
	readonly agentsDir: string;
	readonly workspaceDir: string;
	/** `agent.sqlite`, `hooks.json` and `connectors.json`: state the server keeps, in the half the agent cannot see. */
	readonly dataDir: string;
	/** The token hashes and the session key (`auth.ts`). */
	readonly config: string;
	/** The names a browser may claim as its author: the roster, read per request (`roster.ts`). */
	readonly roster: string;
	/** The key masonry logs into the tool machine with, and the pinned host key beside it. */
	readonly sshDir: string;
	/** The copy of pi's `settings.json` and `auth.json` the server reads (`deploy/mason-entrypoint.sh`). */
	readonly piDir: string;
}

/**
 * The home this process is running against.
 *
 * The prompt sections are installed once, at import time, so they cannot be handed the paths as arguments; the runtime
 * points them at its own home here instead. One process serves one agent home, and tests pass `houseHome` rather than
 * inheriting whatever the developer has in `~/.mason`.
 */
let configured: HousePaths | undefined;

export function configureHouse(paths: HousePaths): HousePaths {
	configured = paths;
	return paths;
}

/**
 * Where a home is: the path given, else `MASON_HOME`, else `~/.mason`.
 *
 * `~` is expanded here because `MASON_HOME=~/x` is what a person writes in a shell, and a literal `~` in a path is a
 * directory name no file is ever in.
 */
export function housePaths(home = process.env.MASON_HOME ?? join(homedir(), ".mason")): HousePaths {
	home = resolve(home.startsWith("~/") ? join(homedir(), home.slice(2)) : home);
	const agentDir = join(home, "agent");
	const serviceDir = join(home, "service");
	return {
		home,
		agentDir,
		serviceDir,
		soul: join(serviceDir, "soul.md"),
		profile: join(agentDir, "profile.md"),
		logDir: join(agentDir, "log"),
		journalDir: join(agentDir, "journal"),
		skillsDir: join(agentDir, "skills"),
		agentsDir: join(agentDir, "agents"),
		workspaceDir: join(agentDir, "workspace"),
		dataDir: join(serviceDir, "data"),
		config: join(serviceDir, "config.json"),
		roster: join(serviceDir, "roster.json"),
		sshDir: join(serviceDir, "ssh"),
		piDir: join(serviceDir, "pi"),
	};
}

/** The file a fact is appended to today: one file per day, so a log grows at the speed of reading. */
export function logPathFor(paths: HousePaths, at = new Date()): string {
	const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
	return join(paths.logDir, `${day}.md`);
}

/** The home the prompt is rendered against: whatever this process configured, else the default resolution. */
export function currentHouse(): HousePaths {
	return configured ?? housePaths();
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** The directories of a layout, both halves, deepest first: what a fresh install creates and a migration ensures. */
function layoutDirectories(paths: HousePaths): string[] {
	return [
		paths.home,
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
	];
}

/** One entry the split moves: the name it has at the home root, and the half it belongs to. */
export interface HouseEntry {
	readonly name: string;
	readonly half: "agent" | "service";
}

/** The entries the split moves. A migration walks exactly this list, and a legacy home is recognised by the same one. */
export const HOUSE_ENTRIES: readonly HouseEntry[] = [
	{ name: "profile.md", half: "agent" },
	{ name: "log", half: "agent" },
	{ name: "journal", half: "agent" },
	{ name: "skills", half: "agent" },
	{ name: "agents", half: "agent" },
	{ name: "workspace", half: "agent" },
	{ name: "soul.md", half: "service" },
	{ name: "config.json", half: "service" },
	{ name: "roster.json", half: "service" },
	{ name: "ssh", half: "service" },
	{ name: "pi", half: "service" },
	{ name: "data", half: "service" },
];

/** The entries a home from before the split still has at its root, in the order a person reads them. */
function legacyEntries(paths: HousePaths): string[] {
	return HOUSE_ENTRIES.filter((entry) => existsSync(join(paths.home, entry.name))).map((entry) => entry.name);
}

/**
 * A home from before the split cannot be opened. Said once, where boot prepares the home, before it writes anything.
 *
 * Booting one would create `agent/` and `service/` beside the old files and write `service/soul.md` from
 * `DEFAULT_SOUL` while Denis's own soul sat unread at the root — which both loses his soul and makes the migration
 * refuse, because every entry would then be at the root *and* in its new half. So the check runs first and creates
 * nothing: the layout is a decision for a person, and `npm run doctor -- migrate` is the command that makes it.
 */
export function refuseLegacyHome(paths: HousePaths): void {
	const legacy = legacyEntries(paths);
	if (legacy.length === 0) return;
	throw new Error(
		`${paths.home} predates the split: ${legacy.join(", ")} ${legacy.length === 1 ? "is" : "are"} still at the ` +
			"root. This home needs to be moved into agent/ and service/ first — run `npm run doctor -- migrate`, then " +
			"start the server again. Nothing was created.",
	);
}

/**
 * Create the home if it is missing and put the default soul in place, once.
 *
 * An absent `soul.md` is a fresh install, and a fresh install should start from the text the product ships rather than
 * from a constant nobody can edit. An existing file is never touched: it is Denis's.
 *
 * Both halves are created together: a home without `service/` is a server with nowhere to put its credentials, and a
 * home without `agent/` is an agent with no memory. A home that predates the split is refused before either is created.
 */
export async function ensureHouse(paths: HousePaths, defaultSoul: string): Promise<void> {
	refuseLegacyHome(paths);
	for (const directory of layoutDirectories(paths)) {
		// `mode` only applies to directories this call creates, so an existing directory is tightened explicitly: a home
		// from before this rule is `0755`, and it is the transcript inside that matters, not the age of the directory.
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await tighten(directory);
	}
	if (!existsSync(paths.soul)) await writeFile(paths.soul, `${defaultSoul}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Best effort: a home on a filesystem without Unix modes is still a home. */
async function tighten(path: string): Promise<void> {
	try {
		await chmod(path, 0o700);
	} catch {
		// Nothing to do: the platform does not have modes to set.
	}
}

/** A file's text, trimmed, or `undefined` when it is absent or empty. */
export async function readHouseFile(path: string): Promise<string | undefined> {
	try {
		const text = await readFile(path, "utf8");
		const trimmed = text.trim();
		return trimmed === "" ? undefined : trimmed;
	} catch {
		return undefined;
	}
}

/**
 * Text cut to a budget, so a long file cannot eat the prompt.
 *
 * Cutting on a line boundary keeps the result readable and, more importantly, keeps the prefix byte-stable between
 * two renders of an unchanged file.
 */
export function capText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const cut = text.slice(0, maxChars);
	const line = cut.lastIndexOf("\n");
	return `${line > 0 ? cut.slice(0, line) : cut}\n\n(truncated at ${maxChars} characters)`;
}

/**
 * Append one dated fact to today's log, and commit it, through the execution environment.
 *
 * Both halves of the job happen where the files are: the append and the `git` commit run on the tool machine, over the
 * same `agent/` volume the server and the agent both see. A commit that depended on a second process in another
 * container would be a history that stops at the first crash.
 *
 * The commit is best-effort: a memory write that lands but does not commit is still a memory, and losing the fact
 * because git was busy would be the worse failure.
 */
export async function appendFact(
	env: ExecutionEnv,
	paths: HousePaths,
	fact: string,
	context: Context,
	at = new Date(),
): Promise<string> {
	const path = logPathFor(paths, at);
	const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
	const line = `- ${time} — ${fact.replace(/\s+/g, " ").trim()}\n`;
	const append = await env.exec(
		[
			"sh",
			"-c",
			// `mkdir -p` the day's directory, create the heading only if it is not there yet, then append the line. The
			// heading uses `noclobber`, so the create is atomic: two `remember` calls in one turn run concurrently, and
			// a read-modify-write of the whole file would let the later writer drop the earlier fact.
			'f=$1; mkdir -p "${f%/*}" && { set -o noclobber; printf "# %s\\n\\n" "$2" > "$f"; } 2>/dev/null; printf "%s" "$3" >> "$f"',
			"mason-log",
			path,
			basename(path, ".md"),
			line,
		],
		undefined,
		context,
	);
	if (!append.ok) throw new Error(`cannot append to ${path}: ${append.error.message}`);
	if (append.value.exitCode !== 0) throw new Error(`cannot append to ${path}: sh exited ${append.value.exitCode}`);
	await commitMemory(env, paths, `memory: ${fact.slice(0, 60)}`, path, context);
	return path;
}

/** Commit the one file a memory write touched, in the home's repository, on the machine the file is on. */
async function commitMemory(
	env: ExecutionEnv,
	paths: HousePaths,
	message: string,
	path: string,
	context: Context,
): Promise<void> {
	const commit = await env.exec(
		[
			"sh",
			"-c",
			// Only the file this call wrote: a directory-wide `add` would commit Denis's half-written profile edit under a
			// memory message. No repository, an identical fact or no git identity all exit non-zero and are ignored.
			'git -C "$1" add -- "$2" && git -C "$1" -c user.name=mason -c user.email=mason@localhost commit --quiet -m "$3"',
			"mason-commit",
			paths.agentDir,
			path,
			message,
		],
		undefined,
		context,
	);
	if (!commit.ok) return;
}

/**
 * Initialise the agent's half as a git repository, so every memory write is something Denis can revert.
 *
 * The repository lives inside `agent/` because that is the half the tool machine mounts: `git` runs there, on the
 * agent's own files, and the same history is readable from the server. `service/` is deliberately unversioned.
 */
export async function ensureRepository(agentDir: string): Promise<void> {
	if (existsSync(join(agentDir, ".git"))) return;
	try {
		await run("git", ["init", "--quiet"], { cwd: agentDir });
	} catch {
		// No git on the host: the files are still there, which is the part that matters.
	}
}

/** One file or directory the migration carried from the old layout to its half. */
export interface HouseMove {
	readonly from: string;
	readonly to: string;
}

export type MigrationOutcome =
	| { readonly status: "moved"; readonly moves: readonly HouseMove[]; readonly committed: boolean }
	| { readonly status: "unchanged" }
	| { readonly status: "refused"; readonly reason: string };

/**
 * Move a home laid out before the split into the two halves, once, and leave each with the history it should have.
 *
 * The rules, in the order they matter:
 * - **Ambiguous is refused, not guessed.** The same entry at the root and in its half is two candidates for one file; a
 *   human did something and only a human knows which one is real. An *empty* destination is not ambiguity: a half
 *   created by a boot that then found the old files is a layout this finishes.
 * - **A second run is a no-op.** Everything already in its half means there is nothing to move.
 * - **Unknown files stay put.** Only `HOUSE_ENTRIES` move; a file mason has never heard of is not an upgrade's business.
 * - **`agent/` is the only half a repository is allowed to see.** The move is staged as a rename for agent-half entries,
 *   because those files are the agent's memory and are the ones a history should follow. A service-half entry is a plain
 *   filesystem rename that never enters an index: `ssh/`, `config.json` and `data/` hold the key, the token hashes and
 *   the transcript, and `agent/` is mounted into the tool machine.
 * - **The old repository is frozen where it stands, not moved.** It stays at the home root, on the server, holding what
 *   it held before the split; both halves leave its index and enter its `.gitignore`, so the agent's writes are not dirt
 *   in it forever. The agent's own repository is created fresh in `agent/`, and its history begins at the migration.
 */
export async function migrateHouse(paths: HousePaths): Promise<MigrationOutcome> {
	const conflicts: string[] = [];
	for (const entry of HOUSE_ENTRIES) {
		if (!existsSync(join(paths.home, entry.name))) continue;
		if (await populated(join(halfDir(paths, entry.half), entry.name))) conflicts.push(entry.name);
	}
	if (conflicts.length > 0) {
		return {
			status: "refused",
			reason: `both layouts are present at once: ${conflicts.join(", ")} ${
				conflicts.length === 1 ? "exists" : "exist"
			} at the root and in the new half. Decide which one is real, remove the other, and run this again.`,
		};
	}

	const pending = HOUSE_ENTRIES.filter((entry) => existsSync(join(paths.home, entry.name)));
	if (pending.length === 0) return { status: "unchanged" };

	const repositoryAtRoot = existsSync(join(paths.home, ".git"));
	// Only the two halves are created here: a moved directory lands where its name says, and pre-creating `agent/log`
	// would make `git mv log agent/log` move the log into itself.
	await mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.serviceDir, { recursive: true, mode: 0o700 });

	const moves: HouseMove[] = [];
	for (const entry of pending) {
		const from = join(paths.home, entry.name);
		const to = join(halfDir(paths, entry.half), entry.name);
		// An empty destination is not a second candidate, but it is in the way: `git mv log agent/log` would move the log
		// *into* the directory it was meant to become. It is what a boot before the check above left behind.
		await rmdir(to).catch(() => undefined);
		if (repositoryAtRoot && entry.half === "agent") {
			// `git mv` when the home is a repository, so the move is a rename in the history rather than a delete and an
			// add; a plain rename otherwise, because the files are what matter.
			try {
				await run("git", ["mv", "--", from, to], { cwd: paths.home });
				moves.push({ from, to });
				continue;
			} catch {
				// Not tracked, or no git: fall through to the plain move.
			}
		}
		// The service half moves here, and only here: no index, no staging, nothing that could carry the key or the
		// token hashes into a history.
		await rename(from, to);
		moves.push({ from, to });
	}

	// Whatever the old home did not have — a journal, worker definitions, a workspace — exists from here on.
	for (const directory of layoutDirectories(paths)) await mkdir(directory, { recursive: true, mode: 0o700 });

	const committed = repositoryAtRoot && (await freezeRootRepository(paths, pending));
	await startAgentRepository(paths);
	return { status: "moved", moves, committed };
}

/** Whether a destination already holds something: a directory with no entries in it is not a second candidate. */
async function populated(path: string): Promise<boolean> {
	const entries = await readdir(path).catch(() => undefined);
	// `undefined` is either "not there" (no conflict) or "there and not a directory" — a file, which is a conflict.
	return entries === undefined ? existsSync(path) : entries.length > 0;
}

/**
 * Leave the pre-split repository at the home root, holding what it held, and blind to both halves from now on.
 *
 * The index loses both halves, `.gitignore` names them so nothing the agent writes into `agent/` is ever pending here,
 * and one commit records the fact. What the old history held it still holds: this repository is the server's, it stays
 * on the server, and no path inside the tool machine is ever this one.
 */
async function freezeRootRepository(paths: HousePaths, pending: readonly HouseEntry[]): Promise<boolean> {
	try {
		// `agent/` because the agent's own repository owns those paths now, `service/` because those files were never
		// the agent's memory, and the moved root paths because they are gone from under their old names. `--cached`
		// removes index entries only; `--ignore-unmatch` accepts an entry that was never tracked.
		await run("git", ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", "agent", "service"], {
			cwd: paths.home,
		});
		await run(
			"git",
			["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...pending.map((entry) => entry.name)],
			{ cwd: paths.home },
		);
		await ignoreHalves(paths.home);
		await run("git", ["add", "--", ".gitignore"], { cwd: paths.home });
		await commitAt(paths.home, "The halves are separate from this repository");
		return true;
	} catch {
		// No git identity, or git refused: the files moved either way, and this repository is not the memory.
		return false;
	}
}

/** Add `agent/` and `service/` to the home root's `.gitignore`, keeping whatever a person already put in it. */
async function ignoreHalves(home: string): Promise<void> {
	const path = join(home, ".gitignore");
	const existing = (await readFile(path, "utf8").catch(() => "")).trim();
	const lines = new Set(existing.split("\n").map((line) => line.trim()));
	const missing = ["agent/", "service/"].filter((line) => !lines.has(line));
	if (missing.length === 0) return;
	await writeFile(path, existing === "" ? `${missing.join("\n")}\n` : `${existing}\n${missing.join("\n")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

/** The agent's own repository: created at the migration, so its history begins there rather than in a moved index. */
async function startAgentRepository(paths: HousePaths): Promise<void> {
	// `workspace/` is scratch, not memory: committing whatever a tool left there would put the agent's working files in
	// the history it reads.
	await writeFile(join(paths.agentDir, ".gitignore"), "workspace/\n", { encoding: "utf8", mode: 0o600 });
	await ensureRepository(paths.agentDir);
	try {
		await run("git", ["add", "-A"], { cwd: paths.agentDir });
	} catch {
		return;
	}
	await commitAt(paths.agentDir, "The agent's memory starts here");
}

/** The directory a half's entries live in. */
function halfDir(paths: HousePaths, half: "agent" | "service"): string {
	return half === "agent" ? paths.agentDir : paths.serviceDir;
}

async function commitAt(cwd: string, subject: string, body?: string): Promise<void> {
	try {
		await run(
			"git",
			[
				"-c",
				"user.name=mason",
				"-c",
				"user.email=mason@localhost",
				"commit",
				"--quiet",
				"-m",
				subject,
				...(body === undefined ? [] : ["-m", body]),
			],
			{ cwd },
		);
	} catch {
		// Nothing to commit, or no git identity: the files moved either way.
	}
}
