/**
 * `mason new <name>` — one bot under the root: a home, the soul and skills every home starts with, a first connector,
 * and a doctor line that says what the four produced.
 *
 * The home is today's home, unchanged (`house.ts`), so nothing downstream of this command has to know a fleet exists: the
 * bot's `agent/` and `service/` are what `MASON_HOME` would have pointed at. What is new is only where it sits — one
 * directory under the root — and that the root has to be initialised first: a bot with no common store has no provider,
 * and a bot that boots into "no model configured" is a first run that failed after the files were written.
 *
 * The first connector is `setup`'s flow, called with this bot's home rather than the ambient one. With `--yes` and no
 * `--connector` or `--url`, it installs the console: the one connector that needs no token, no image and no container, so
 * a scripted first run ends in a bot somebody can talk to instead of a refusal asking for a flag.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { commonReady } from "../src/server/common.ts";
import { doctorExitCode, formatCheck, runDoctor } from "../src/server/doctor.ts";
import { botPaths, ensureHouse, ensureRepository } from "../src/server/house.ts";
import { DEFAULT_SOUL } from "../src/server/prompt.ts";
import { BOT_NAME, botHome, COMMON, readRoot, refuseHomeEnv, rootPath } from "../src/server/root.ts";
import { runSetup } from "./setup.ts";

export interface NewArgs {
	readonly name?: string;
	/** Everything setup understands, passed through untouched: the first connector is setup's flow. */
	readonly setup: readonly string[];
	readonly help: boolean;
}

export function usage(): string {
	return `usage: mason new <name> [setup flags]

  Create one bot under the root: its home (agent/ and service/), the soul and skills every home starts with, a first
  connector, and a doctor line for the result. The root must be initialised (\`mason init\`).

  <name>                 lowercase letters, digits and dashes; it is the directory under the root
  --connector <name>     the first connector, one from the catalog or \`console\` (the default with --yes)
  --url <ws-url>         a connector already running somewhere else; implies --connector custom
  --env NAME=value       one answer a connector needs; repeatable
  --owner <id>           who owns this chat
  --events <kind=hook>   a url: connector's event kinds
  --no-start             write the connector's files and leave its container down
  --yes                  take the flags it has and ask nothing
  --help                 this

  next: mason up -b <name>, or mason chat -b <name>.`;
}

/** The name and setup's own argv, split at the first token that is not the name. */
export function parseArgs(argv: readonly string[]): NewArgs {
	const name = argv[0] !== undefined && !argv[0].startsWith("-") ? argv[0] : undefined;
	const setup = name === undefined ? [...argv] : argv.slice(1);
	return { ...(name === undefined ? {} : { name }), setup, help: setup.includes("--help") || setup.includes("-h") };
}

/** Whether setup's argv already names the connector it will install. */
export function namesConnector(setup: readonly string[]): boolean {
	return setup.some(
		(arg) => arg === "--url" || arg.startsWith("--url=") || arg === "--connector" || arg.startsWith("--connector="),
	);
}

/** The command. Returns an exit code rather than calling `process.exit`, so a test can run the flow in-process. */
export async function runNew(
	argv: readonly string[],
	options: {
		readonly root?: string;
		readonly doctor?: boolean;
		/**
		 * Whether this command installs the first connector. `mason new` does; the onboarding wizard does not, because it
		 * has already collected that connector's answers and installs it as a step of its own, and two installs of the same
		 * connector in one run would be one too many.
		 */
		readonly setup?: boolean;
	} = {},
): Promise<number> {
	const args = parseArgs(argv);
	if (args.help) {
		console.log(usage());
		return 0;
	}
	try {
		refuseHomeEnv();
		const root = readRoot(options.root ?? rootPath());
		const name = args.name;
		if (name === undefined) throw new Error("a bot needs a name: `mason new <name>`");
		if (!BOT_NAME.test(name) || name === COMMON)
			throw new Error(`"${name}" is not a bot name: lowercase letters, digits and dashes, and not "${COMMON}"`);
		const home = botHome(root.root, name);
		if (existsSync(home))
			throw new Error(`bot "${name}" already exists at ${home}: \`mason bots\` lists what there is`);
		if (!(await commonReady(root.root)))
			throw new Error(
				`${root.root} has no common store: run \`mason init\` first (it stores the provider every bot shares), or ` +
					"`mason onboard`, which initialises the root and creates the first bot",
			);
		const target = { root: root.root, name, home };
		const paths = botPaths(target);
		await mkdir(home, { recursive: true, mode: 0o700 });
		await ensureHouse(paths, DEFAULT_SOUL);
		await ensureRepository(paths.agentDir);
		console.log(`[new] created bot "${name}" at ${home}`);
		if (options.setup !== false) {
			const setup =
				args.setup.includes("--yes") && !namesConnector(args.setup)
					? [...args.setup, "--connector", "console"]
					: args.setup;
			const code = await runSetup(setup, { house: paths });
			if (code !== 0) return code;
		}
		if (options.doctor === false) return 0;
		const checks = await runDoctor({ house: paths });
		for (const check of checks) console.log(`[new] ${formatCheck(check)}`);
		const failed = checks.filter((check) => !check.ok).length;
		console.log(`[new] ${checks.length} checks: ${checks.length - failed} ok, ${failed} failed`);
		console.log(`[new] next: mason up -b ${name} (or \`mason chat -b ${name}\`)`);
		return doctorExitCode(checks);
	} catch (error) {
		console.error(`[new] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runNew(process.argv.slice(2)));
}
