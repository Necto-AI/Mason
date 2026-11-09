/**
 * `mason onboard` — the one door a stranger walks through, and a dispatcher behind it.
 *
 * The first run used to be a sequence: create a home, then find a connector, then hand-write a grant, then mint a
 * credential, then start the server, then start the container yourself (#145). #147 gives each of those a command of its
 * own — `init` once per root, `new` per bot, `setup` per connector — and this is the door that decides which of them a
 * given root still needs: no common store, run `init`; no bot, run `new`; a bot with no connector, run `setup`; a bot
 * that has all three, say so and prove it with a doctor.
 *
 * That is also why running it twice is safe (#147, criterion 2). Everything it would ask is answered by a file that is
 * already there, so the second run asks nothing about providers or keys and adds nothing twice. The flags it takes are
 * the union of the three commands' flags, split here: a provider answer goes to `init`, a connector answer to `setup`.
 *
 * Several bots and no `-b` is a refusal naming them, never a guess: the command that would otherwise pick one is the
 * command that installs a connector into somebody else's bot.
 */
import { commonReady } from "../src/server/common.ts";
import { doctorExitCode, formatCheck, runDoctor } from "../src/server/doctor.ts";
import { botPaths } from "../src/server/house.ts";
import { readIntegrations } from "../src/server/integrations.ts";
import { type BotTarget, botNames, readRoot, refuseHomeEnv, resolveBot, rootPath } from "../src/server/root.ts";
import { runInit } from "./init.ts";
import { namesConnector, runNew } from "./new.ts";
import { type OnboardingOptions, runOnboarding } from "./onboarding.ts";
import { runSetup } from "./setup.ts";
import { MissingAnswer } from "./wizard.ts";

/** Every connector `--connector <name>` (or `--connector=<name>`) names, in the order written. */
function connectorsNamed(setup: readonly string[]): string[] {
	const names: string[] = [];
	for (let index = 0; index < setup.length; index += 1) {
		const arg = setup[index];
		if (arg === "--connector") {
			const name = setup[index + 1];
			if (name !== undefined) names.push(name);
			continue;
		}
		if (arg?.startsWith("--connector=") === true) names.push(arg.slice("--connector=".length));
	}
	return names;
}

export interface OnboardArgs {
	readonly bot?: string;
	/** What `mason init` understands. */
	readonly init: readonly string[];
	/** What `mason setup` understands. */
	readonly setup: readonly string[];
	readonly yes: boolean;
	readonly help: boolean;
}

export function usage(): string {
	return `usage: mason onboard [flags]

  The first run, in one command: initialise the root if it has no common store, create the first bot if there is none,
  install its first connector if it has none, and finish with \`mason doctor\`. Run it again and it asks nothing: what is
  there is reported, not repeated.

  -b, --bot <name>       which bot, when the root holds several
  --provider <id>        the provider to store (mason init)
  --model <id>           the model to store (mason init)
  --key <key>            the provider's API key (mason init)
  --connector <name>     a connector, one from the catalog or \`console\`; repeat it for a second (mason setup)
  --url <ws-url>         a connector already running somewhere else; implies --connector custom
  --env NAME=value       one answer a connector needs; repeatable
  --owner <id>           who owns this chat
  --conversations <ids>  a url: connector's conversations
  --events <kind=hook>   a url: connector's event kinds
  --no-start             write the connector's files and leave its container down
  --yes                  take the flags it has and ask nothing
  --help                 this`;
}

const INIT_FLAGS = new Set(["--provider", "--model", "--key"]);
const SETUP_FLAGS = new Set(["--connector", "--url", "--env", "--owner", "--conversations", "--events"]);
const SETUP_BOOLEANS = new Set(["--no-start", "--start"]);

/** The union of the three commands' flags, split into the two argv lists they belong to. */
export function parseArgs(argv: readonly string[]): OnboardArgs {
	const init: string[] = [];
	const setup: string[] = [];
	let bot: string | undefined;
	let yes = false;
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const flag = equals === -1 ? arg : arg.slice(0, equals);
		const inline = equals === -1 ? undefined : arg.slice(equals + 1);
		const value = (): string => {
			if (inline !== undefined) return inline;
			const next = argv[index + 1];
			if (next === undefined) throw new Error(`${flag} needs a value`);
			index += 1;
			return next;
		};
		if (flag === "--help" || flag === "-h") {
			help = true;
		} else if (flag === "--bot" || flag === "-b") {
			bot = value();
		} else if (flag === "--yes" || flag === "-y") {
			yes = true;
			init.push("--yes");
			setup.push("--yes");
		} else if (INIT_FLAGS.has(flag)) {
			init.push(flag, value());
		} else if (SETUP_FLAGS.has(flag)) {
			setup.push(flag, value());
		} else if (SETUP_BOOLEANS.has(flag)) {
			setup.push(flag);
		} else {
			throw new Error(`unknown argument ${arg}; \`mason onboard --help\` lists the flags`);
		}
	}
	return { ...(bot === undefined ? {} : { bot }), init, setup, yes, help };
}

/** The command. Returns an exit code rather than calling `process.exit`, so a test can run the flow in-process. */
export async function runOnboard(
	argv: readonly string[],
	options: {
		readonly root?: string;
		readonly doctor?: boolean;
		/** Injected by a test: the wizard's screens and its operations, so the whole flow runs without a terminal. */
		readonly onboarding?: Omit<OnboardingOptions, "bot" | "init" | "setup" | "root">;
		/** Injected by a test: whether this run has a terminal, which is the one thing a test process never has. */
		readonly interactive?: boolean;
	} = {},
): Promise<number> {
	let args: OnboardArgs;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(`[onboard] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	if (args.help) {
		console.log(usage());
		return 0;
	}
	try {
		refuseHomeEnv();
		// A terminal and no `--yes` is the wizard: same commands, asked rather than passed. Everything below is the
		// scripted path, unchanged — `--yes`, a pipe, and a test all take it.
		const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
		if (!args.yes && interactive && options.doctor !== false)
			return await runOnboarding({
				...(args.bot === undefined ? {} : { bot: args.bot }),
				init: args.init,
				setup: args.setup,
				...(options.root === undefined ? {} : { root: options.root }),
				...options.onboarding,
			});
		// `--yes` answers the connector question too: a scripted first run that stalls on "which connector?" has answered
		// nothing, and the half-created root it left behind used to be discovered after the bot was written.
		const setupArgs =
			args.yes && !namesConnector(args.setup) ? [...args.setup, "--connector", "console"] : args.setup;
		if (!process.stdin.isTTY && !namesConnector(setupArgs))
			throw new Error(
				"no terminal, and no connector was named: pass --connector <name>, or --yes for the console one. " +
					"Nothing was created.",
			);
		let root = readRoot(options.root ?? rootPath());
		console.log(`[onboard] root: ${root.root}`);
		if (!(await commonReady(root.root))) {
			const code = await runInit(args.init, { root: root.root });
			if (code !== 0) return code;
			root = readRoot(root.root);
		} else {
			console.log(`[onboard] the common store exists: nothing asked about providers or keys`);
		}

		let bot: BotTarget | undefined;
		let created = false;
		const named = args.bot ?? (process.env.MASON_BOT === "" ? undefined : process.env.MASON_BOT);
		if (named !== undefined) {
			// A name on a root with no bots is the first bot's name; a name beside other bots is a target, and a typo there is
			// a refusal with the list rather than a home created in the wrong place.
			if (root.bots.length === 0) {
				const code = await runNew([named, ...setupArgs], { root: root.root, doctor: false });
				if (code !== 0) return code;
				root = readRoot(root.root);
				// By name: the bot this run just created, not whatever MASON_BOT or "the only bot" would say about a root
				// this process only now learned the shape of.
				bot = resolveBot(root, { bot: named });
				created = true;
			} else {
				bot = resolveBot(root, { bot: named });
			}
		} else if (root.bots.length === 1) {
			bot = resolveBot(root);
		} else if (root.bots.length === 0) {
			const code = await runNew(["bot", ...setupArgs], { root: root.root, doctor: false });
			if (code !== 0) return code;
			root = readRoot(root.root);
			bot = resolveBot(root, { bot: "bot" });
			created = true;
		} else {
			console.error(
				`[onboard] ${root.root} holds ${root.bots.length} bots: ${botNames(root)}. Pick one with \`-b <name>\`, or set ` +
					"MASON_BOT.",
			);
			return 1;
		}
		if (bot === undefined) return 1;
		const paths = botPaths(bot);
		console.log(`[onboard] bot: ${bot.name} (${paths.home})`);

		if (!created) {
			const { integrations } = await readIntegrations(paths);
			const granted = Object.keys(integrations)
				.filter((name) => integrations[name]?.connector !== undefined)
				.sort();
			// A flag that names a connector which is not granted yet is a request, not a duplicate: it used to be dropped
			// with "nothing installed twice" and an exit code that said the run had done what was asked. With a repeated
			// flag the request is a list, and one missing name is enough to run setup for all of them.
			const named = connectorsNamed(setupArgs);
			const missing = named.filter((name) => !granted.includes(name));
			if (granted.length === 0 || missing.length > 0) {
				const code = await runSetup(setupArgs, { house: paths });
				if (code !== 0) return code;
			} else if (named.length > 0) {
				console.log(`[onboard] already granted: ${named.join(", ")}; nothing installed twice`);
			} else {
				console.log(
					`[onboard] already granted: ${granted.join(", ")}; pass \`--connector <name>\` to add another, or ` +
						"`mason setup` to change this one",
				);
			}
		}

		if (options.doctor === false) return 0;
		const checks = await runDoctor({ house: paths });
		for (const check of checks) console.log(`[onboard] ${formatCheck(check)}`);
		const failed = checks.filter((check) => !check.ok).length;
		console.log(`[onboard] ${checks.length} checks: ${checks.length - failed} ok, ${failed} failed`);
		console.log(`[onboard] next: mason up -b ${bot.name}`);
		return doctorExitCode(checks);
	} catch (error) {
		console.error(`[onboard] ${error instanceof Error ? error.message : String(error)}`);
		return error instanceof MissingAnswer ? 2 : 1;
	}
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runOnboard(process.argv.slice(2)));
}
