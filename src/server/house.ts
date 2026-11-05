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
 *     ├── integrations.json   # the services mason reaches (`integrations.ts`)
 *     ├── ssh/                # the key mason logs into the env machine with
 *     ├── pi/                 # the copy of the provider credential
 *     └── data/               # agent.sqlite, hooks.json, seeded-skills.json
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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { SHIPPED_SKILLS_DIR } from "./extensions/skills.ts";

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
	/**
	 * `agent.sqlite`, `hooks.json` and the record of seeded skills: state the server keeps, in the half the agent cannot
	 * see.
	 */
	readonly dataDir: string;
	/** The token hashes and the session key (`auth.ts`). */
	readonly config: string;
	/**
	 * The services mason reaches — an MCP endpoint and a trigger per entry — read once at boot (`integrations.ts`). Not in
	 * `HOUSE_ENTRIES`: the file arrived after the split, so no home from before it has one to carry across.
	 */
	readonly integrations: string;
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
		integrations: join(serviceDir, "integrations.json"),
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
	await seedShippedSkills(paths);
}

/**
 * Copy the skills mason ships into the agent's half, and keep them current.
 *
 * `SHIPPED_SKILLS_DIR` is a path inside the repository, and the tool machine has the home, not the repository: scanned
 * from there, `generative-ui` would be indexed in the dev stack and absent in the deployment while the prompt went on
 * telling the model to read it. Seeding puts one root on both machines.
 *
 * A copy that is never updated is worse than no copy at all: the prompt tells the model the shipped skill carries the
 * parameter order the renderer depends on, so an old manual answers for the renderer. What was seeded is therefore
 * recorded, in the half the agent cannot see (`service/data/seeded-skills.json`, name to the sha256 of the copied
 * `SKILL.md`), and a copy whose hash still matches the record is one nobody touched: the shipped copy replaces it. A
 * copy that differs from the record was edited — by the agent, by Denis, or by a person who brought their own skill of
 * that name before there was a record — and is left alone, with the seeded hash still beside it so no later boot takes
 * it for one of ours.
 *
 * `shippedDir` is the repository's `skills/` unless a caller names another: the upgrade rule needs a "before" and an
 * "after" of the same skill, and a test should not have to edit the checkout to get one.
 */
export async function seedShippedSkills(paths: HousePaths, shippedDir = SHIPPED_SKILLS_DIR): Promise<void> {
	const recordPath = join(paths.dataDir, SEEDED_SKILLS);
	const seeded = await readSeededSkills(recordPath);
	const record: Record<string, string> = {};
	for (const name of await readdir(shippedDir).catch(() => [] as string[])) {
		const source = join(shippedDir, name);
		const target = join(paths.skillsDir, name);
		const shipped = await hashOf(join(source, "SKILL.md"));
		if (shipped === undefined) continue;
		const copy = await hashOf(join(target, "SKILL.md"));
		if (copy === undefined) {
			await cp(source, target, { recursive: true, force: false }).catch(() => undefined);
			record[name] = shipped;
			continue;
		}
		if (seeded[name] === copy) {
			// Ours, and nobody edited it: the shipped bytes win, which is how an upgrade reaches a home that booted before it.
			if (copy !== shipped) await cp(source, target, { recursive: true, force: true }).catch(() => undefined);
			record[name] = shipped;
			continue;
		}
		// Edited, or never seeded by this code: not ours to overwrite.
		if (seeded[name] !== undefined) record[name] = seeded[name];
	}
	await writeFileIfChanged(recordPath, `${JSON.stringify(record, null, "\t")}\n`);
}

/** The file that remembers what was seeded, in the half no tool can read. */
const SEEDED_SKILLS = "seeded-skills.json";

/** What a previous boot seeded: skill name to the sha256 of the `SKILL.md` it copied. */
async function readSeededSkills(path: string): Promise<Record<string, string>> {
	const text = await readFile(path, "utf8").catch(() => undefined);
	if (text === undefined) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
	} catch {
		// A record nobody can read is a record of nothing: absent means "do not replace what is there", which is safe.
		return {};
	}
}

/** The sha256 of a file's bytes, or `undefined` when there is no such file. */
async function hashOf(path: string): Promise<string | undefined> {
	const bytes = await readFile(path).catch(() => undefined);
	return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
}

/** Write `text` to `path` unless it already says exactly that, so a boot that changes nothing touches nothing. */
async function writeFileIfChanged(path: string, text: string): Promise<void> {
	if ((await readFile(path, "utf8").catch(() => undefined)) === text) return;
	await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
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
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
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
 *
 * A repository created here is committed in the same breath. The files a home starts with — the profile, the skills
 * seeded from the repository — are the agent's first memory, not untracked dirt in a repository nothing was ever
 * committed to. `workspace/` is left out: it is scratch, and a tool's half-finished file is not a memory.
 *
 * Both answers to "is this half safe to commit into" are refusals, thrown before `git init` and before anything is
 * staged: a `service/` directory here is the key, the token hashes and the transcript readable on the volume the tool
 * machine mounts, and a repository copy other than `agent/.git` is a history that may hold them. Ignoring either would
 * leave the key in that volume while the server called the home fine, so boot stops instead.
 */
export async function ensureRepository(agentDir: string): Promise<void> {
	const home = dirname(agentDir);
	if (existsSync(join(agentDir, "service"))) throw new Error(serviceInAgentHalf(home));
	const stray = await strayRepositories(agentDir);
	if (stray.length > 0) throw new Error(strayRepository(home, stray[0] as string));
	if (existsSync(join(agentDir, ".git"))) return;
	try {
		await run("git", ["init", "--quiet"], { cwd: agentDir });
	} catch {
		// No git on the host: the files are still there, which is the part that matters.
		return;
	}
	await commitAgentTree(agentDir, "The agent's memory starts here");
}

/**
 * Where a tainted history goes: outside the home, and named after it.
 *
 * `agent/` is the volume the tool machine mounts, so a repository moved *within* it — `agent/.git.old` is what the first
 * version of this repair told an operator to do — is the key still in the volume, one `git cat-file` away. The one
 * destination this module names is a sibling of the home, which no mount reaches.
 */
function historyAsidePath(home: string): string {
	return join(dirname(home), `${basename(home)}-agent-history.bak`);
}

/** Why a history that holds the service half cannot stay where it is, and the one move that repairs it. */
function taintedHistory(paths: HousePaths, leaked: readonly string[]): string {
	const gitDir = join(paths.agentDir, ".git");
	return (
		`${gitDir} predates this fix: its history holds ${leaked.slice(0, 3).join(", ")}${
			leaked.length > 3 ? ` and ${leaked.length - 3} more` : ""
		}, paths from the half no tool may see. ${paths.agentDir} is the volume the tool machine mounts, so a copy of that ` +
		`repository left anywhere inside it is the key readable again. Move the repository out of the home — ` +
		`\`mv ${gitDir} ${historyAsidePath(paths.home)}\` — and run this again: the agent's files are what matter, not that history.`
	);
}

/**
 * Every repository copy inside the agent's half other than `agent/.git` itself.
 *
 * A `.git` below the top level is a checked-out repository, and a name of the form `.git.old` or `.git.bak` is a
 * history somebody moved aside — which is exactly what the first version of this repair told them to create. Both are
 * `agent/`, both are the volume the tool machine mounts, and either can hold the service half; only the agent's own
 * repository belongs here. A plain file such as `.gitignore` is not a copy of anything and is not one of these.
 */
async function strayRepositories(agentDir: string): Promise<string[]> {
	const own = join(agentDir, ".git");
	const found: string[] = [];
	const pending = [agentDir];
	while (pending.length > 0) {
		const directory = pending.pop() as string;
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const path = join(directory, entry.name);
			// The one repository the layout allows, and nothing inside it is a second one.
			if (path === own) continue;
			if (entry.name === ".git" || entry.name.startsWith(".git.")) {
				found.push(path);
				continue;
			}
			// Symlinks are not followed: a link is not the repository, and a loop is not worth walking into.
			if (entry.isDirectory()) pending.push(path);
		}
	}
	return found;
}

/** Why a second repository in the agent's half is refused rather than ignored, and where it goes instead. */
function strayRepository(home: string, path: string): string {
	return (
		`${path} is repository-like and inside ${join(home, "agent")}, the volume the tool machine mounts: whatever history ` +
		`it holds is readable from a tool, and a history carried over from before the split holds the service half. ` +
		`Move it out of the home — \`mv ${path} ${historyAsidePath(home)}\` — and start again.`
	);
}

/** Why a `service/` directory in the agent's half is a leak, and the two repairs: it belongs in `service/`, or nowhere. */
function serviceInAgentHalf(home: string): string {
	return (
		`${join(home, "agent", "service")} is inside the agent's half, the volume the tool machine mounts: the key, the ` +
		`token hashes and the transcript are readable from a tool while they sit here, and this repository would commit ` +
		`them. Move what is in it into ${join(home, "service")} — the server's half is where a service-owned file ` +
		`belongs — or delete it, then run this again.`
	);
}

/** One file or directory the migration carried from the old layout to its half. */
export interface HouseMove {
	readonly from: string;
	readonly to: string;
}

export type MigrationOutcome =
	/** `moves` were carried across. `committed` says the repository at the root really was frozen, not that it was tried. */
	| { readonly status: "moved"; readonly moves: readonly HouseMove[]; readonly committed: boolean }
	/** Nothing was left at the root. `finished` names what an interrupted earlier run had left undone and this one did. */
	| { readonly status: "unchanged"; readonly finished: readonly string[] }
	| { readonly status: "refused"; readonly reason: string };

/**
 * Move a home laid out before the split into the two halves, once, and leave each with the history it should have.
 *
 * The rules, in the order they matter:
 * - **Ambiguous is refused, not guessed.** The same entry at the root and in its half is two candidates for one file; a
 *   human did something and only a human knows which one is real. An *empty* destination is not ambiguity: a half
 *   created by a boot that then found the old files is a layout this finishes.
 * - **A second run is a no-op.** Everything already in its half means there is nothing to move — but not that the
 *   home is finished, so that path verifies the migration's tail and completes it (`finishHouse`).
 * - **Unknown files stay put.** Only `HOUSE_ENTRIES` move; a file mason has never heard of is not an upgrade's business.
 * - **`agent/` is the only half a repository is allowed to see.** Every entry moves with a plain filesystem rename: no
 *   index is staged, so no path from `ssh/`, `config.json` or `data/` can be carried into a history on the way. The
 *   agent's own repository is then created fresh in `agent/`, and its history begins at the migration, with the files
 *   as they landed.
 * - **The old repository is frozen where it stands, not moved.** It stays at the home root, on the server, holding what
 *   it held before the split; both halves leave its index and enter its `.gitignore`, so the agent's writes are not dirt
 *   in it forever.
 * - **A history that already holds the service half is refused.** A home moved by the abandoned first version has
 *   `service/config.json` and the key in `agent/.git`, and says `unchanged` like a finished one; history is not something
 *   this command can rewrite for a person, so it says what to do instead: move the repository out of the home.
 * - **Nothing else repository-like stays in the agent's half.** A second `.git`, or a `.git.old` an operator moved the
 *   tainted history to, is a history on the volume the tool machine mounts; both this command and boot refuse it, naming
 *   the path and the same destination outside the home.
 * - **`service/` inside `agent/` is a leak, not a layout.** The files that belong to the server's half are refused before
 *   anything is committed, by the same check boot runs, so no history is ever written with the key in it.
 */
export async function migrateHouse(paths: HousePaths): Promise<MigrationOutcome> {
	const leaked = await servicePathsIn(paths.agentDir);
	if (leaked.length > 0) return { status: "refused", reason: taintedHistory(paths, leaked) };
	// The same two checks boot runs, in the same order: a file in the open, then a history beside the agent's own.
	if (existsSync(join(paths.agentDir, "service"))) {
		return { status: "refused", reason: serviceInAgentHalf(paths.home) };
	}
	const stray = await strayRepositories(paths.agentDir);
	if (stray.length > 0) return { status: "refused", reason: strayRepository(paths.home, stray[0] as string) };

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
	if (pending.length === 0) return finishHouse(paths);

	const repositoryAtRoot = existsSync(join(paths.home, ".git"));
	// Only the two halves are created here: a moved directory lands where its name says, and pre-creating `agent/log`
	// would make the rename of `log` land inside the directory it was meant to become.
	await mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
	await mkdir(paths.serviceDir, { recursive: true, mode: 0o700 });

	const moves: HouseMove[] = [];
	for (const entry of pending) {
		const from = join(paths.home, entry.name);
		const to = join(halfDir(paths, entry.half), entry.name);
		// An empty destination is not a second candidate, but it is in the way: a rename onto the directory it was meant
		// to become would nest the entry inside itself. It is what a boot before the check above left behind.
		await rmdir(to).catch(() => undefined);
		await rename(from, to);
		moves.push({ from, to });
	}

	// Whatever the old home did not have — a journal, worker definitions, a workspace — exists from here on.
	for (const directory of layoutDirectories(paths)) await mkdir(directory, { recursive: true, mode: 0o700 });

	const committed = repositoryAtRoot && (await freezeRootRepository(paths, pending));
	const refusal = await startAgentRepository(paths);
	return refusal === undefined ? { status: "moved", moves, committed } : { status: "refused", reason: refusal };
}

/**
 * The halves are populated and nothing is left at the root — which is not the same as *finished*.
 *
 * A process that died after the move loop, or between the freeze and the agent's first commit, leaves a home that every
 * rerun reported as `unchanged`: a `workspace/` that is not ignored, a repository boot `git init`ed and never committed
 * to, the agent's files untracked, and a repository at the root still holding both halves. That is exactly the state an
 * operator reads as a green light, so this verifies the tail and finishes what is missing, and says what it finished.
 * Both steps are idempotent: on a home that is genuinely done, nothing here writes anything.
 */
async function finishHouse(paths: HousePaths): Promise<MigrationOutcome> {
	const finished: string[] = [];
	if ((await revisionAt(paths.agentDir)) === undefined) {
		const refusal = await startAgentRepository(paths);
		if (refusal !== undefined) return { status: "refused", reason: refusal };
		// Only a history that is there now is news: a host without git, or a half that is not a directory, leaves none.
		if ((await revisionAt(paths.agentDir)) !== undefined) {
			finished.push(`the agent's first commit in ${join(paths.agentDir, ".git")}`);
		}
	}
	if (existsSync(join(paths.home, ".git")) && !(await ignoresHalves(paths.home))) {
		// Everything that is now in a half has to leave the index, whether this run moved it there or an earlier one did.
		const settled = HOUSE_ENTRIES.filter((entry) => existsSync(join(halfDir(paths, entry.half), entry.name)));
		// Only a commit that happened is news: a freeze git refused already left the repository at the root as it was.
		if (await freezeRootRepository(paths, settled)) finished.push(`the freeze of the repository at ${paths.home}`);
	}
	return { status: "unchanged", finished };
}

/**
 * The service-half paths a repository's history holds, if it has one.
 *
 * The abandoned first version of this migration moved the service entries into `agent/` and committed them there, so
 * `agent/.git` — the one history the tool machine mounts — holds `service/config.json` and `service/ssh/`, the token
 * hashes and the key. No command can rewrite someone else's history safely, and the files are what matter, so the
 * migration refuses and names the repair instead of reporting the home as already split.
 */
async function servicePathsIn(dir: string): Promise<string[]> {
	if ((await revisionAt(dir)) === undefined) return [];
	const log = await run("git", ["log", "--all", "--name-only", "--pretty=format:"], { cwd: dir }).catch(
		() => undefined,
	);
	if (log === undefined) return [];
	return log.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line === "service" || line.startsWith("service/"));
}

/**
 * The revision the repository at `dir` names, or `undefined` when it has no `.git` of its own or has committed nothing.
 *
 * The `existsSync` is load-bearing: `git` walks up from its cwd, so asking inside a home whose root is a repository would
 * answer with the root's HEAD and the migration would take a half with no repository for one with a history.
 */
async function revisionAt(dir: string): Promise<string | undefined> {
	if (!existsSync(join(dir, ".git"))) return undefined;
	const head = await run("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: dir }).catch(() => undefined);
	return head?.stdout.trim() || undefined;
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
 * on the server, and no path inside the tool machine is ever this one. `false` means no commit happened — no identity,
 * or git refused — because an operator who is told the repository was frozen will not look again.
 */
async function freezeRootRepository(paths: HousePaths, pending: readonly HouseEntry[]): Promise<boolean> {
	try {
		// `agent/` because the agent's own repository owns those paths now, `service/` because those files were never
		// the agent's memory, and the moved root paths because they are gone from under their old names. `--cached`
		// removes index entries only; `--ignore-unmatch` accepts an entry that was never tracked.
		await run("git", ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", "agent", "service"], {
			cwd: paths.home,
		});
		if (pending.length > 0) {
			await run(
				"git",
				["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...pending.map((entry) => entry.name)],
				{ cwd: paths.home },
			);
		}
		await addIgnoreLines(join(paths.home, ".gitignore"), HALVES_IGNORE);
		await run("git", ["add", "--", ".gitignore"], { cwd: paths.home });
		return await commitAt(paths.home, "The halves are separate from this repository");
	} catch {
		// No git identity, or git refused: the files moved either way, and this repository is not the memory.
		return false;
	}
}

/** The lines that blind the home root's repository to both halves. */
const HALVES_IGNORE = ["agent/", "service/"];

/** Whether the home root's `.gitignore` already names both halves. */
async function ignoresHalves(home: string): Promise<boolean> {
	const lines = await ignoreLines(join(home, ".gitignore"));
	return HALVES_IGNORE.every((line) => lines.has(line));
}

/** A `.gitignore`'s lines. An absent file is an empty one: a person who wrote none ignores nothing. */
async function ignoreLines(path: string): Promise<Set<string>> {
	const existing = (await readFile(path, "utf8").catch(() => "")).trim();
	return new Set(existing.split("\n").map((line) => line.trim()));
}

/** Add the lines a `.gitignore` is missing, keeping whatever a person already put in it. */
async function addIgnoreLines(path: string, wanted: readonly string[]): Promise<void> {
	const lines = await ignoreLines(path);
	const missing = wanted.filter((line) => !lines.has(line));
	if (missing.length === 0) return;
	const existing = (await readFile(path, "utf8").catch(() => "")).trim();
	await writeFile(path, existing === "" ? `${missing.join("\n")}\n` : `${existing}\n${missing.join("\n")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

/**
 * The agent's own repository, with the files it holds as its first commit: created at the migration, so its history
 * begins there rather than in a moved index, or finished there when boot had already `git init`ed it.
 *
 * Returns the reason when the half is not safe to commit into — a `service/` path, or a stray repository — because the
 * migration is one command an operator reads, not a stack trace; boot runs the same check and lets it throw.
 */
async function startAgentRepository(paths: HousePaths): Promise<string | undefined> {
	try {
		await ensureRepository(paths.agentDir);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	// `ensureRepository` returns early on a repository that already exists, so a half boot prepared has no commit yet.
	await commitAgentTree(paths.agentDir, "The agent's memory starts here");
	return undefined;
}

/** Stage the agent's half and commit it, with `workspace/` and `service/` excluded: scratch and the server's half are not memory. */
async function commitAgentTree(agentDir: string, subject: string): Promise<void> {
	try {
		// Inside the `try`: a caller may race a directory that is not there, and the ignore file is written only to stage.
		await addIgnoreLines(join(agentDir, ".gitignore"), AGENT_IGNORE);
		await run("git", ["add", "-A"], { cwd: agentDir });
	} catch {
		return;
	}
	await commitAt(agentDir, subject);
}

/**
 * What the agent's history never holds: `workspace/` is a tool's half-finished file, and a `service/` path here is the
 * leak the split exists to prevent. The latter is refused before staging as well; this is the last line, not the rule.
 */
const AGENT_IGNORE = ["workspace/", "service/"];

/** The directory a half's entries live in. */
function halfDir(paths: HousePaths, half: "agent" | "service"): string {
	return half === "agent" ? paths.agentDir : paths.serviceDir;
}

async function commitAt(cwd: string, subject: string, body?: string): Promise<boolean> {
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
		return true;
	} catch {
		// Nothing to commit, or no git identity: the files moved either way, and the caller says what it got.
		return false;
	}
}
