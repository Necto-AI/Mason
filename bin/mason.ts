#!/usr/bin/env node
/**
 * `mason`, the one command the installed package answers with.
 *
 * The subcommands are the npm scripts of a checkout, mapped thin: every one except `onboard` runs the very script file
 * the npm script runs, compiled to `dist/`, so an installed bot and a checkout bot take their orders from the same
 * code. There are no new nouns here: what the panel and the token class used to serve is `curl /api/health` on one
 * side and the connector's own vocabulary on the other.
 *
 * `onboard` is the only composite, because a first run is exactly the moment the pieces have no order yet. It calls the
 * functions the scripts call, over the home this process resolves (`MASON_HOME`, else `~/.mason`, the real home): the
 * house is created as a fresh install or refused with its names, a connector entry that has a grant but no credential
 * yet gets one minted once, and the doors plus the next step are printed. It never writes an `integrations.json`
 * entry: the grant is the operator's decision, and `mason integration add` is where it starts.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listConnectorCredentials, mintConnectorCredential } from "../src/server/connectors.ts";
import { DEFAULT_SOUL } from "../src/server/prompt.ts";
import { ensureHouse, housePaths } from "../src/server/house.ts";
import { readIntegrations } from "../src/server/integrations.ts";
import { DOORS } from "../scripts/surface.ts";

/** The checkout root and the install share this file's relative neighbourhood, computed once from where it runs. */
const here = dirname(fileURLToPath(import.meta.url));

/** The subcommand → script map, written as .ts and closed: every unmapped noun is, deliberately, not a command. */
const SCRIPTS: Readonly<Record<string, string>> = {
	up: "../src/server/main.ts",
	prompt: "../scripts/prompt.ts",
	surface: "../scripts/surface.ts",
	integration: "../scripts/integration.ts",
	connector: "../scripts/connector.ts",
	setup: "../scripts/setup.ts",
	chat: "../scripts/chat.ts",
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
  mason up                     serve the bot (the server this checkout starts with npm run dev)
  mason onboard                create the home, mint a connector credential, print the doors
  mason setup                  install a connector: grant, credential, compose project, container
  mason chat                   talk to the bot from this terminal, through the console connector
  mason integration …          add|remove|enable|disable|list: the services mason reaches
  mason connector …            list|add|revoke: the credentials a connector opens its socket with
  mason prompt                 print the prompt a turn would send, rendered by the faux provider
  mason surface                render the door tables (docs/SURFACE.md), relative to the current directory
  mason eval                   run the behaviour scenarios

The home is \$MASON_HOME, else ~/.mason. The one unauthenticated door is /api/health; everything else
speaks the connector's credential. Stop a running bot: SIGINT or SIGTERM.`);
	process.exit(process.argv[2] === "--help" || process.argv[2] === "-h" ? 0 : 1);
}

/** First-run bookkeeping: the house, one credential, the doors, the next step. No entry is written here. */
async function onboard(): Promise<void> {
	const house = housePaths();
	console.log(`[onboard] home: ${house.home}`);
	// Idempotent by design: an existing soul, profile or seeded skill is never overwritten, and a home from before the
	// split is refused with the entries it still carries at the root.
	await ensureHouse(house, DEFAULT_SOUL);
	console.log(`[onboard] soul at ${house.soul} (left untouched if you already wrote one)`);

	const { integrations } = await readIntegrations(house);
	const granted = Object.entries(integrations)
		.filter(([, entry]) => entry.connector !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	if (granted.length === 0) {
		console.log(`
[onboard] no connector is granted yet: a person speaks through one, and the credential is the
only thing mason hands it. Next:

  mason integration add <name> --url <mcp-url> --description "<the one line the model is told>"
  ...write the "connector" block (the owner actor, the conversations, the event kinds) into the
      entry by hand: ${house.integrations}
  mason connector add <name>      # or: mason onboard, which mints it and prints it once
  mason up
`);
	} else {
		const issued = await listConnectorCredentials(house.home);
		for (const [name] of granted) {
			if (issued.some((record) => record.connector === name)) {
				console.log(`[onboard] "${name}" has a connector credential (${house.config}); nothing minted`);
				continue;
			}
			const { credential, record } = await mintConnectorCredential(house.home, name, { replace: false });
			console.log(`[onboard] minted ${record.id} for "${name}"`);
			console.log(credential);
			console.log("this is the only time it is printed. restart mason: the entry list is read at boot.");
		}
	}

	console.log("\n[onboard] the doors of this process:");
	for (const door of DOORS) {
		console.log(`  ${door.path}${door.kind === "public" ? "" : "  (connector credential)"}  ${door.why}`);
	}
	console.log("\n[onboard] next: mason up");
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === "onboard") {
		await onboard();
		return;
	}
	const script = command !== undefined ? SCRIPTS[command] : undefined;
	if (script === undefined) usage();
	// The wrapper has nothing of its own to say: the child's exit is this command's exit, and a script's
	// stdout/stderr are the operator's terminal exactly as `npm run …` delivers them.
	const { path, flags } = scriptLoader(script);
	const child = spawn(process.execPath, [...flags, path, ...args], { stdio: "inherit" });
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
