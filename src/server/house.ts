/**
 * `~/.mason/` — everything the agent is made of, in one directory.
 *
 * The pattern: the agent's identity and memory are files Denis can read, diff and revert, not rows in a database he
 * cannot type into. This module owns the layout and the reads; nothing else in the server builds a path by hand.
 *
 * ```text
 * ~/.mason/
 * ├── soul.md                 # the first section of the system prompt
 * ├── profile.md              # who Denis is, agent-managed, always in the prompt
 * ├── log/2026-10-20.md       # dated facts, one per line, read on demand
 * ├── skills/<name>/SKILL.md  # same format as ~/dev/pi-setup/skills
 * ├── workspace/              # the directory the agent works in, separate from the code that runs it
 * └── data/                   # agent.sqlite and hooks.json: the state, in the same home it describes
 * ```
 *
 * `roster.json` (who is in the room, `roster.ts`) and `config.json` (the credentials, `auth.ts`) sit beside them;
 * `housePaths` builds both, so a module that needs one of them is handed a path rather than a home to join itself. The
 * one exception left is `configPath` in `auth.ts`: it predates the rule, and `readConfig`/`writeConfig` still take a
 * home. Leaving a second home-joining helper beside it would be worse than naming this one.
 *
 * Config, plugins and hooks join the same directory later; keeping one home is the point.
 *
 * The home is `0700`, files in it `0600`: it holds a transcript of everything Denis said, which is not a thing to leave
 * readable by every other account on the machine.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface HousePaths {
	readonly home: string;
	readonly soul: string;
	readonly profile: string;
	readonly logDir: string;
	readonly skillsDir: string;
	readonly workspaceDir: string;
	/** Where `agent.sqlite` and `hooks.json` live: inside the home, so one directory is the whole agent. */
	readonly dataDir: string;
	/** The names a browser may claim as its author: the roster, read per request (`roster.ts`). */
	readonly roster: string;
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
	return {
		home,
		soul: join(home, "soul.md"),
		profile: join(home, "profile.md"),
		logDir: join(home, "log"),
		skillsDir: join(home, "skills"),
		workspaceDir: join(home, "workspace"),
		dataDir: join(home, "data"),
		roster: join(home, "roster.json"),
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

/**
 * Create the home if it is missing and put the default soul in place, once.
 *
 * An absent `soul.md` is a fresh install, and a fresh install should start from the text the product ships rather than
 * from a constant nobody can edit. An existing file is never touched: it is Denis's.
 */
export async function ensureHouse(paths: HousePaths, defaultSoul: string): Promise<void> {
	// `mode` only applies to directories this call creates, so an existing home is tightened explicitly: a home from
	// before this rule is `0755`, and it is the transcript inside that matters, not the age of the directory.
	await mkdir(paths.home, { recursive: true, mode: 0o700 });
	await tighten(paths.home);
	for (const directory of [paths.logDir, paths.skillsDir, paths.workspaceDir, paths.dataDir]) {
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
 * Append one dated fact to today's log, and commit it when the home is a git repository.
 *
 * The commit is best-effort: a memory write that lands but does not commit is still a memory, and losing the fact
 * because git was busy would be the worse failure.
 */
export async function appendFact(paths: HousePaths, fact: string, at = new Date()): Promise<string> {
	const path = logPathFor(paths, at);
	await mkdir(paths.logDir, { recursive: true });
	const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
	const line = `- ${time} — ${fact.replace(/\s+/g, " ").trim()}\n`;
	// Two `remember` calls in one turn run concurrently, so the heading is created once and every fact appended: a
	// read-modify-write of the whole file would let the later writer drop the earlier fact.
	try {
		await writeFile(path, `# ${basename(path, ".md")}\n\n`, { flag: "wx" });
	} catch {
		// Today's file is already there.
	}
	await appendFile(path, line, "utf8");
	await commitIfRepository(paths.home, `memory: ${fact.slice(0, 60)}`, path);
	return path;
}

/** Initialise the home as a git repository, so every memory write is something Denis can revert. */
export async function ensureRepository(home: string): Promise<void> {
	if (existsSync(join(home, ".git"))) return;
	try {
		await run("git", ["init", "--quiet"], { cwd: home });
	} catch {
		// No git on the host: the files are still there, which is the part that matters.
	}
}

async function commitIfRepository(home: string, message: string, path: string): Promise<void> {
	if (!existsSync(join(home, ".git"))) return;
	try {
		// Only the file this call wrote: the home is Denis's, and a stray `git add -A` would commit his half-written
		// soul edit under a memory message.
		await run("git", ["add", "--", path], { cwd: home });
		await run("git", ["-c", "user.name=mason", "-c", "user.email=mason@localhost", "commit", "--quiet", "-m", message], {
			cwd: home,
		});
	} catch {
		// Nothing staged (an identical fact) or no git identity: the file is written either way.
	}
}
