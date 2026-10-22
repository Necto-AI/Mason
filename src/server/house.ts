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
 * The home is `0700`, files in it `0600`: it holds a transcript of everything Denis said, which is not a thing to leave
 * readable by every other account on the machine.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/**
 * Create the home if it is missing and put the default soul in place, once.
 *
 * An absent `soul.md` is a fresh install, and a fresh install should start from the text the product ships rather than
 * from a constant nobody can edit. An existing file is never touched: it is Denis's.
 *
 * Both halves are created together: a home without `service/` is a server with nowhere to put its credentials, and a
 * home without `agent/` is an agent with no memory.
 */
export async function ensureHouse(paths: HousePaths, defaultSoul: string): Promise<void> {
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

/** The entries the split moves, and which half each belongs to. A migration walks exactly this list. */
export const HOUSE_ENTRIES: readonly { readonly name: string; readonly half: "agent" | "service" }[] = [
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
 * Move a home laid out before the split into the two halves, once, and record it as a commit in the home's own
 * history.
 *
 * The rules, in the order they matter:
 * - **Ambiguous is refused, not guessed.** The same entry in both places is two candidates for one file; a human did
 *   something and only a human knows which one is real. A half-finished run is not ambiguous — it is finished here.
 * - **A second run is a no-op.** Everything already in its half means there is nothing to move.
 * - **Unknown files stay put.** Only `HOUSE_ENTRIES` move; a file mason has never heard of is not an upgrade's business.
 * - **Two commits, each saying something true.** First the move, in the repository at the root, where every path is a
 *   rename and `git log --follow` survives. Then the repository itself relocates into `agent/` and the service half
 *   leaves it: `service/` is unversioned from then on.
 */
export async function migrateHouse(paths: HousePaths): Promise<MigrationOutcome> {
	const conflicts = HOUSE_ENTRIES.filter(
		(entry) => existsSync(join(paths.home, entry.name)) && existsSync(join(halfDir(paths, entry.half), entry.name)),
	).map((entry) => entry.name);
	if (existsSync(join(paths.home, ".git")) && existsSync(join(paths.agentDir, ".git"))) conflicts.push(".git");
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
		if (repositoryAtRoot) {
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
		await rename(from, to);
		moves.push({ from, to });
	}

	if (repositoryAtRoot) {
		// `git mv` stages its own rename; a plain move has to be staged, and only the destination: a `git add -A` would
		// sweep a file mason has never heard of into a commit about the layout.
		for (const move of moves) await run("git", ["add", "--", move.to], { cwd: paths.home }).catch(() => undefined);
	}

	// Whatever the old home did not have — a journal, worker definitions, a workspace — exists from here on.
	for (const directory of layoutDirectories(paths)) await mkdir(directory, { recursive: true, mode: 0o700 });

	if (!repositoryAtRoot) return { status: "moved", moves, committed: false };

	await commitAt(paths.home, "Split the home into agent-owned and service-owned files");
	await relocateRepository(paths);
	return { status: "moved", moves, committed: true };
}

/** The directory a half's entries live in. */
function halfDir(paths: HousePaths, half: "agent" | "service"): string {
	return half === "agent" ? paths.agentDir : paths.serviceDir;
}

/**
 * Move the repository into `agent/` and commit the service half's departure.
 *
 * After the first commit the repository still tracks both halves. Relocated to `agent/`, the service half is outside its
 * worktree, which is exactly the fact the second commit records: those files are not the agent's history any more.
 */
async function relocateRepository(paths: HousePaths): Promise<void> {
	await rename(join(paths.home, ".git"), join(paths.agentDir, ".git"));
	// The index still names paths relative to the old root, so every file re-roots here and the service half becomes a
	// deletion. `workspace/` is excluded: the directory the agent works in is not its memory, and committing whatever a
	// tool left there would put the agent's scratch files in its history.
	await run("git", ["add", "-A", "--", ".", ":(exclude)workspace"], { cwd: paths.agentDir });
	await commitAt(
		paths.agentDir,
		"The service-owned files leave this repository",
		"The repository now sits in agent/, so the paths that stayed re-root here too. soul.md, roster.json,\n" +
			"config.json, ssh/, pi/ and data/ are outside it from now on: the server's half is not versioned.",
	);
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
