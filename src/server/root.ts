/**
 * The mason root: one directory per bot, and `common/` beside them.
 *
 * A bot is still one home in two halves (`house.ts`), and nothing about the split moves. What this module adds is the
 * directory above it: `~/.mason` (or `MASON_ROOT`) holds `common/` — the store every bot shares, written by `mason
 * init` — and one directory per bot, each of which is today's home, unchanged. `MASON_HOME` still names one home
 * directly, which is how a home from before the fleet layout keeps booting.
 *
 * Two refusals live here, and both name the manual move rather than performing one. A root whose halves sit at the root
 * itself is a single home wearing the root's name, and opening it as a root would create `common/` and bot directories
 * beside an operator's soul; the error says where the halves belong. And a name that is not a directory under the root
 * is not a bot, so `-b` with a typo is a list of what there is instead of a home created in the wrong place.
 *
 * Targeting is one order, written once: `-b` beats `MASON_BOT`, which beats "the only bot", which beats a refusal that
 * names every bot. Every command that has to know which bot it is about calls `resolveBot`, so no two verbs can disagree
 * about which home they mean.
 *
 * Listing is synchronous on purpose. `housePaths()` is a path computation every reader uses without awaiting it, and a
 * bot's home has to be known before the first `await` of any command; one `readdirSync` of a directory with a handful of
 * entries is cheaper than making every reader asynchronous.
 */
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** A name in this root is a directory name, so it is the same grammar an integration name and a connector name use. */
export const BOT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The one directory under the root that is not a bot: the store every bot shares. */
export const COMMON = "common";

/**
 * Every entry a home carries at its own root, from before the split (`house.ts` refuses one). A root that holds any of
 * them is one home addressed as a fleet, and the refusal names it rather than creating a second layout around it.
 */
export const HOME_ENTRIES: readonly string[] = [
	"profile.md",
	"log",
	"journal",
	"skills",
	"agents",
	"workspace",
	"soul.md",
	"config.json",
	"ssh",
	"pi",
	"data",
];

/** One bot under a root: its name, which is its directory, and the home that directory holds. */
export interface Bot {
	readonly name: string;
	readonly home: string;
}

/** The root and what is under it. `common/` is a path here, never a bot. */
export interface MasonRoot {
	readonly root: string;
	readonly commonDir: string;
	readonly bots: readonly Bot[];
}

/** A resolved target: the root it came from and the bot's home. */
export interface BotTarget {
	readonly root: string;
	readonly name: string;
	readonly home: string;
}

/** `~` is what a person types in a shell, and a literal `~` in a path is a directory no file is ever in. */
export function expandHome(path: string): string {
	return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

/** The root this process is about: `MASON_ROOT`, else `~/.mason`. `MASON_HOME` is a home, not a root, and is checked first
 * by the caller that resolves a home (`housePaths`). */
export function rootPath(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.MASON_ROOT;
	return expandHome(configured === undefined || configured === "" ? join(homedir(), ".mason") : configured);
}

/** One bot's home: its own directory under the root, holding the same two halves a `MASON_HOME` home holds. */
export function botHome(root: string, name: string): string {
	return join(expandHome(root), name);
}

/** Whether a directory under the root is a bot: today's home is `agent/` and `service/`, and either half is enough to
 * recognise one. A directory with neither is somebody else's file, not a bot. */
function isBot(home: string): boolean {
	return existsSync(join(home, "agent")) || existsSync(join(home, "service"));
}

/**
 * A root whose halves sit at the root itself is one home, not a fleet, and this version does not move it.
 *
 * The refusal is the split's refusal one level up: `agent/` beside `common/` would be a bot with no name, and creating
 * `common/` and a bot directory around an operator's soul would leave the real soul unread. It says the move, because a
 * move is the one thing it will not do.
 */
export function refuseLegacyRoot(root: string): void {
	// The two halves of a home that has already split, and the entries of one that has not: either way the directory is a
	// single home, and opening it as a root would put `common/` and a bot directory around an operator's files. A bot
	// directory is never one of them, whatever it is called: `mason new data` is a bot named after a legacy entry, not a
	// root holding a home's `data/`. An *empty* directory is not one either: `mason new log` creates the name before it
	// creates the halves, and a run killed in that window must not refuse every command about a directory mason made.
	// `agent/` and `service/` are the split's own halves: their presence is the signal, empty or not. The older entries
	// only count when they carry something, because `mason new log` creates its directory before its halves.
	const found = ["agent", "service", ...HOME_ENTRIES].filter((name) => {
		const path = join(root, name);
		if (!existsSync(path) || isBot(path)) return false;
		return name === "agent" || name === "service" || carriesFiles(path);
	});
	if (found.length === 0) return;
	throw new Error(
		`${root} holds a single home's halves at the root (${found.join(", ")}): the fleet layout keeps one directory ` +
			`per bot under it, and \`common/\` beside them. Move them into one bot by hand — ` +
			`\`mkdir ${join(root, "<name>")} && mv ${found.map((name) => join(root, name)).join(" ")} ${join(root, "<name>")}/\` ` +
			`— or point MASON_HOME at ${root} to keep it as one home. Nothing was created.`,
	);
}

/** Whether a path holds anything: a file always does, an empty directory never. */
function carriesFiles(path: string): boolean {
	try {
		return readdirSync(path).length > 0;
	} catch {
		// A file answers ENOTDIR: it is one of the old entries, and the refusal is about it.
		return true;
	}
}

/**
 * The inverse of `refuseLegacyRoot`: a *root* opened as one home.
 *
 * `~/.mason` is a root now, and a command that treats it as a home writes `agent/` and `service/` beside `common/` and the
 * bots — after which every fleet command refuses, about directories the tool just made. `mason prompt` did exactly that,
 * and the cost was permanent until somebody deleted the halves by hand. The check lives here because `ensureHouse` is the
 * only writer, so every verb that could do it is covered by one refusal.
 */
export function refuseRootAsHome(home: string): void {
	if (!existsSync(join(home, COMMON))) return;
	const bots = readEntries(home).filter(
		(entry) =>
			entry.isDirectory() && entry.name !== COMMON && !entry.name.startsWith(".") && isBot(join(home, entry.name)),
	);
	if (bots.length === 0) return;
	throw new Error(
		`${home} is a mason root, not one home: it holds ${COMMON}/ and the bots ${bots.map((bot) => bot.name).join(", ")}. ` +
			"Pick one with `-b <name>`, or set MASON_HOME to the home you mean. Nothing was created.",
	);
}

/**
 * The root as it is: every bot directory, sorted by name, and where `common/` goes.
 *
 * A root that does not exist yet is an empty fleet, not a refusal: `mason onboard` is the command that creates it, and it
 * has to be able to look before it writes.
 */
export function readRoot(root = rootPath()): MasonRoot {
	const resolved = expandHome(root);
	refuseLegacyRoot(resolved);
	const names = readEntries(resolved)
		.filter((entry) => entry.isDirectory() && entry.name !== COMMON && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.filter((name) => BOT_NAME.test(name) && isBot(join(resolved, name)))
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	return {
		root: resolved,
		commonDir: join(resolved, COMMON),
		bots: names.map((name) => ({ name, home: botHome(resolved, name) })),
	};
}

/**
 * The fleet commands work on a root, and `MASON_HOME` names one home instead: the two are different questions, and a
 * command that silently answered the wrong one would write to `~/.mason` while a person believed it was writing to their
 * home. `mason up`, `setup`, `chat` and `doctor` are per-home verbs and keep honouring it.
 */
export function refuseHomeEnv(env: NodeJS.ProcessEnv = process.env): void {
	if (env.MASON_HOME === undefined || env.MASON_HOME === "") return;
	throw new Error(
		`MASON_HOME names one home (${env.MASON_HOME}), and this command works on a root. Unset it, or set MASON_ROOT to ` +
			"the directory the bots live under. A single home keeps booting with `mason up`, `mason setup` and `mason doctor`.",
	);
}

/** The root's entries, or none when it does not exist: a root that is not there is an empty fleet, not an error. */
function readEntries(directory: string): Dirent[] {
	try {
		return readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** `-b <name>` (or `--bot=<name>`) taken out of argv: the one parser, so the wrapper and the `npm run` path cannot disagree. */
export function takeBotFlag(argv: readonly string[]): { readonly bot?: string; readonly rest: readonly string[] } {
	const rest: string[] = [];
	let bot: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "-b" || arg === "--bot") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error(`${arg} needs a bot name; \`mason bots\` lists them`);
			bot = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--bot=")) {
			bot = arg.slice("--bot=".length);
			continue;
		}
		rest.push(arg);
	}
	return { ...(bot === undefined ? {} : { bot }), rest };
}

/** `takeBotFlag` plus the `MASON_BOT` export it implies: what a script calls before it resolves a home. */
export function takeBot(argv: readonly string[]): string[] {
	const { bot, rest } = takeBotFlag(argv);
	if (bot !== undefined) process.env.MASON_BOT = bot;
	return [...rest];
}

/** The names of every bot, for a refusal that has to list them. */
export function botNames(root: MasonRoot): string {
	return root.bots.map((bot) => bot.name).join(", ") || "none";
}

/**
 * Which bot a command is about: `-b`, else `MASON_BOT`, else the only bot, else a refusal naming every bot.
 *
 * A named bot that is not there is its own refusal rather than a fall-through to "the only bot": a typo must not land the
 * command on a different home. The three refusals all say the next command, because a person who has just typed one is
 * the person who needs it.
 */
export function resolveBot(
	root: MasonRoot,
	options: { readonly bot?: string; readonly env?: NodeJS.ProcessEnv } = {},
): BotTarget {
	const env = options.env ?? process.env;
	const named = options.bot ?? (env.MASON_BOT === "" ? undefined : env.MASON_BOT);
	if (named !== undefined) {
		if (!BOT_NAME.test(named))
			throw new Error(
				`"${named}" is not a bot name: lowercase letters, digits and dashes, starting with a letter or a digit`,
			);
		const found = root.bots.find((bot) => bot.name === named);
		if (found === undefined)
			throw new Error(
				`there is no bot "${named}" under ${root.root}: it knows ${botNames(root)}. \`mason bots\` lists them, and ` +
					"`mason new <name>` creates one.",
			);
		return { root: root.root, name: found.name, home: found.home };
	}
	const only = root.bots.length === 1 ? root.bots[0] : undefined;
	if (only !== undefined) return { root: root.root, name: only.name, home: only.home };
	if (root.bots.length === 0)
		throw new Error(
			`${root.root} has no bot yet: run \`mason onboard\` to initialise the root and create the first one, or ` +
				"`mason new <name>` once it is initialised.",
		);
	throw new Error(
		`${root.root} holds ${root.bots.length} bots: ${botNames(root)}. Pick one with \`-b <name>\`, or set MASON_BOT.`,
	);
}
