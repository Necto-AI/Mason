#!/usr/bin/env node
/**
 * `mason`, the one command the installed package answers with.
 *
 * The subcommands are the npm scripts of a checkout, mapped thin: every one except `onboard` runs the very script file
 * the npm script runs, compiled to `dist/`, so an installed bot and a checkout bot take their orders from the same
 * code. There are no new nouns here: what the panel and the token class used to serve is `curl /api/health` on one
 * side and the connector's own vocabulary on the other.
 *
 * `onboard` is the only composite, because a first run is exactly the moment the pieces have no order yet. It is a
 * dispatcher over the same functions: `init` when the root has no common store, `new` when it has no bot, `setup` when
 * the bot has no connector, and a doctor at the end. It writes what those write, grants included — the wizard's own
 * questions, never a hand-edited `integrations.json`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { takeBot as takeBotArgs } from "../src/server/root.ts";

/** The checkout root and the install share this file's relative neighbourhood, computed once from where it runs. */
const here = dirname(fileURLToPath(import.meta.url));

/** The subcommand → script map, written as .ts and closed: every unmapped noun is, deliberately, not a command. */
const SCRIPTS: Readonly<Record<string, string>> = {
	up: "../src/server/main.ts",
	onboard: "../scripts/onboard.ts",
	init: "../scripts/init.ts",
	new: "../scripts/new.ts",
	bots: "../scripts/bots.ts",
	doctor: "../scripts/doctor.ts",
	status: "../scripts/status.ts",
	setup: "../scripts/setup.ts",
	chat: "../scripts/chat.ts",
	integration: "../scripts/integration.ts",
	connector: "../scripts/connector.ts",
	prompt: "../scripts/prompt.ts",
	surface: "../scripts/surface.ts",
	eval: "../evals/run.ts",
};

/**
 * The script a subcommand runs, wherever this wrapper sits.
 *
 * A compiled install maps `.ts` to the `.js` beside it in `dist/`; a checkout has no `dist`, so the source runs with
 * the type-stripping flag, the same one the npm scripts carry. One wrapper, both answers.
 */
function scriptLoader(target: string): { readonly path: string; readonly flags: readonly string[] } {
	const candidate = join(here, target.replace(/\.ts$/, ".js"));
	if (existsSync(candidate)) return { path: candidate, flags: [] };
	return { path: join(here, target), flags: ["--experimental-strip-types"] };
}

function usage(): never {
	console.log(`usage: mason <command> [args…]

Commands (the npm scripts, mapped thin):
  mason onboard                the first run: init the root, create a bot, install its first connector, doctor
                               (with a terminal it asks; --yes and a pipe answer with flags)
  mason init                   the common store: provider, model, a key verified before it is written
  mason new <name>             one bot under the root: a home, its soul and skills, a first connector
  mason bots                   the bots under the root, and which one a command targets
  mason doctor                 nine read-only checks over one bot; exit 1 on any failure
  mason status                 one line: the bot, its model, its integrations, whether mason is up
  mason up                     serve the bot (the server this checkout starts with npm run dev)
  mason setup                  install a connector: grant, credential, compose project, container
  mason chat                   talk to the bot from this terminal, through the console connector
  mason integration …          add|remove|enable|disable|list: the services mason reaches
  mason connector …            list|add|revoke: the credentials a connector opens its socket with
  mason prompt                 print the prompt a turn would send, rendered by the faux provider
  mason surface                render the door tables (docs/SURFACE.md), relative to the current directory
  mason eval                   run the behaviour scenarios

The root is $MASON_ROOT, else ~/.mason; a bot is one directory under it, and $MASON_HOME names one home directly.
-b <name> (or MASON_BOT) picks the bot when the root holds several; it goes after the command, as
\`mason status -b bob\`. The one unauthenticated door is /api/health; everything else speaks the connector's credential.
Stop a running bot: SIGINT or SIGTERM.`);
	process.exit(process.argv[2] === "--help" || process.argv[2] === "-h" ? 0 : 1);
}

/** `-b <name>` anywhere on the line: `root.ts` parses it once, and exports `MASON_BOT` for the child. */
function takeBot(argv: readonly string[]): string[] {
	try {
		return takeBotArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	const script = command !== undefined ? SCRIPTS[command] : undefined;
	if (script === undefined) usage();
	const args = takeBot(rest);
	// The wrapper has nothing of its own to say: the child's exit is this command's exit, and a script's
	// stdout/stderr are the operator's terminal exactly as `npm run …` delivers them.
	const { path, flags } = scriptLoader(script);
	const child = spawn(process.execPath, [...flags, path, ...args], { stdio: "inherit", env: process.env });
	// The stop signals name this wrapper's pid — the one the operator runs — but the child is the one that
	// must act, so the wrapper forwards them. A TTY's Ctrl-C delivers SIGINT to the whole foreground group
	// already (as `npm run …` does today), so the forward can arrive as a second delivery and the server's
	// handlers run either way. A signal listener would hold the process open after the child is gone, so the
	// child's exit is this command's exit and the wrapper goes with it.
	child.on("exit", (code) => {
		process.exit(code ?? 1);
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			child.kill(signal);
		});
	}
}

await main();
