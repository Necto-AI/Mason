/**
 * `npm run integration -- <list|add|remove|enable|disable|secret> …` — the services mason reaches.
 *
 * The config (`src/server/integrations.ts`) is read once at boot, so this command says what the *next* start does: the
 * tool surface and the prompt are decided then, and a list that changed under a running turn would change what the
 * model can do between two messages of one conversation. Editing the file is a restart, and the command says so every
 * time it writes.
 *
 * It edits the tools face — the one that reaches an MCP endpoint — and the trigger's secret, because a secret is
 * minted rather than typed. The trigger still fires only a hook this build defines, so `secret` asks for the hook on
 * the first run and keeps it afterwards. A secret is never printed by anything else, not even truncated: a person
 * pastes it into the container, and nothing mason prints is a place it should appear.
 */
import { randomBytes } from "node:crypto";
import { housePaths } from "../src/server/house.ts";
import { COMMAND_NAMES, type CommandName, isCommandName } from "../src/server/events.ts";
import {
	readIntegrations,
	removeIntegration,
	setIntegrationEnabled,
	writeIntegration,
} from "../src/server/integrations.ts";

const [command, ...args] = process.argv.slice(2);
const house = housePaths();

function usage(): never {
	console.log(`usage:
  npm run integration -- list
  npm run integration -- add <name> --url <url> --description "<text>" [--replace]
  npm run integration -- remove <name>
  npm run integration -- enable <name>
  npm run integration -- disable <name>
  npm run integration -- secret <name> [--hook <hook-id>]
  npm run integration -- commands <name> <a,b,c>

  home: ${house.home}
  the list is ${house.integrations} (0600, in the server's half) and is read once at boot: a change applies on restart.
  add refuses a name that is already there unless --replace is passed, and a name is lowercase letters, digits and dashes.
  secret mints 32 bytes for the trigger's HMAC key and prints it once; --hook names the hook a first trigger fires.
  commands declares what that trigger may ask mason to do beyond firing the hook: a comma-separated list out of
  ${COMMAND_NAMES.join(", ")}, and an empty list takes the vocabulary away.
  nothing else here prints a secret.`);
	process.exit(command === undefined || command === "--help" ? 0 : 1);
}

function option(name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

async function list(): Promise<void> {
	const { integrations } = await readIntegrations(house);
	const names = Object.keys(integrations).sort();
	if (names.length === 0) console.log(`no integrations (${house.integrations} is empty or absent)`);
	for (const name of names) {
		const integration = integrations[name];
		const tools = integration.tools === undefined ? "no tools" : integration.tools.url;
		const trigger = integration.trigger === undefined ? "no trigger" : `trigger ${integration.trigger.hook}`;
		const commands =
			integration.commands === undefined || integration.commands.length === 0
				? ""
				: `, commands ${integration.commands.join(",")}`;
		console.log(`${name.padEnd(16)}  ${integration.enabled ? "enabled " : "disabled"}  ${tools}  ${trigger}${commands}`);
	}
}

async function add(): Promise<void> {
	const name = args[0];
	if (name === undefined) usage();
	const url = option("--url");
	const description = option("--description");
	if (url === undefined || description === undefined) usage();
	const { integrations } = await readIntegrations(house);
	const existing = integrations[name];
	if (existing !== undefined && !args.includes("--replace")) {
		console.error(`${name} is already an integration: pass --replace to point it at another endpoint`);
		process.exit(1);
	}
	const written = await writeIntegration(house, name, {
		...existing,
		// A replace moves the endpoint and rewrites the description. The switch and the trigger face are what the
		// integration *is*, not where its tools come from, so they stay as they were.
		enabled: existing?.enabled ?? true,
		description,
		tools: { ...existing?.tools, url },
	});
	console.log(`wrote ${written.enabled ? "enabled" : "disabled"} ${name} to ${house.integrations}`);
	console.log(`  ${description}`);
	console.log(`  tools at ${url}`);
	console.log("The list is read once at boot: start the server again for this to take effect.");
}

async function toggle(enabled: boolean): Promise<void> {
	const name = args[0];
	if (name === undefined) usage();
	const written = await setIntegrationEnabled(house, name, enabled);
	if (written === undefined) {
		console.error(`no integration ${name}: \`npm run integration -- list\` shows the ones this home has`);
		process.exit(1);
	}
	console.log(`${enabled ? "enabled" : "disabled"} ${name}`);
	console.log("The list is read once at boot: start the server again for this to take effect.");
}

async function remove(): Promise<void> {
	const name = args[0];
	if (name === undefined) usage();
	if (!(await removeIntegration(house, name))) {
		console.error(`no integration ${name}: nothing to remove`);
		process.exit(1);
	}
	console.log(`removed ${name} from ${house.integrations}`);
	console.log("The list is read once at boot: start the server again for this to take effect.");
}

/**
 * Mints the trigger secret, 32 bytes of it, and stores it through the same atomic write as every other entry. The hook
 * is asked for once and kept: a rotation replaces the key, not the identity of the door. A `--hook` beside an existing
 * trigger is refused rather than ignored, because an operator who passes one is trying to change something.
 */
async function secret(): Promise<void> {
	const name = args[0];
	if (name === undefined) usage();
	const { integrations } = await readIntegrations(house);
	const existing = integrations[name];
	if (existing === undefined) {
		console.error(`no integration ${name}: \`npm run integration -- list\` shows the ones this home has`);
		process.exit(1);
	}
	const asked = option("--hook");
	const current = existing.trigger?.hook;
	if (current !== undefined && asked !== undefined) {
		console.error(`${name} already has a trigger on ${current}: --hook only names the hook of a first secret`);
		process.exit(1);
	}
	const hook = current ?? asked;
	if (hook === undefined) {
		console.error(`${name} has no trigger yet: pass --hook <hook-id>, the hook a delivery there fires`);
		process.exit(1);
	}
	const written = await writeIntegration(house, name, {
		...existing,
		trigger: { ...(existing.trigger ?? {}), hook, secret: randomBytes(32).toString("hex") },
	});
	const trigger = written.trigger;
	if (trigger === undefined) return;
	console.log(`${name} trigger fires ${trigger.hook}; secret in ${house.integrations} (0600):`);
	console.log();
	console.log(`  ${trigger.secret}`);
	console.log();
	console.log("paste it into the sender as the HMAC key; it is shown once, and a new secret replaces it here.");
	console.log("The list is read once at boot: start the server again for this to take effect.");
}

/**
 * Declares what the trigger's secret may ask for beyond a fire.
 *
 * The names are the closed set `events.ts` owns, so an unknown one is refused here by the same validation a boot does,
 * with the whole set in the message: a typo must not become a command that silently never runs. An empty list is how the
 * vocabulary is taken away again, because "none" and "not written" mean the same thing and one of them can be typed.
 */
async function setCommands(): Promise<void> {
	const name = args[0];
	const list = args[1];
	if (name === undefined || list === undefined) usage();
	const { integrations } = await readIntegrations(house);
	const existing = integrations[name];
	if (existing === undefined) {
		console.error(`no integration ${name}: \`npm run integration -- list\` shows the ones this home has`);
		process.exit(1);
	}
	// Narrowed here rather than only in the reader, so a typo is refused before anything is written and the message
	// carries the word the operator typed beside the whole set. The writer validates again on its way in: this is the
	// sentence a person reads, not the last line of defence.
	const commands: CommandName[] = [];
	for (const entry of list.split(",").map((word) => word.trim()).filter((word) => word !== "")) {
		if (!isCommandName(entry)) {
			console.error(
				`${house.integrations}: integration "${name}" declares the command "${entry}", which mason does not have: ` +
					`the whole set is ${COMMAND_NAMES.join(", ")}`,
			);
			process.exit(1);
		}
		commands.push(entry);
	}
	const written = await writeIntegration(house, name, { ...existing, commands });
	const declared = written.commands ?? [];
	console.log(`${name} may issue ${declared.length === 0 ? "no commands" : declared.join(", ")}`);
	console.log("The list is read once at boot: start the server again for this to take effect.");
}

// A refusal from the config module is the operator's message, not a stack trace: the message names the path and the
// entry, which is what a person has to fix.
try {
	if (command === "list") await list();
	else if (command === "add") await add();
	else if (command === "enable") await toggle(true);
	else if (command === "disable") await toggle(false);
	else if (command === "remove") await remove();
	else if (command === "secret") await secret();
	else if (command === "commands") await setCommands();
	else usage();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}