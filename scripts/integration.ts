/**
 * `npm run integration -- <list|add|remove|enable|disable> …` — the services mason reaches.
 *
 * The config (`src/server/integrations.ts`) is read once at boot, so this command says what the *next* start does: the
 * tool surface and the prompt are decided then, and a list that changed under a running turn would change what the
 * model can do between two messages of one conversation. Editing the file is a restart, and the command says so every
 * time it writes.
 *
 * It edits the tools face — the one that reaches an MCP endpoint — because that is the half that exists. The trigger
 * face arrives with #43, and a secret it holds is never printed here, not even truncated: a person pastes it into the
 * container, and nothing mason prints is a place it should appear.
 */
import { housePaths } from "../src/server/house.ts";
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

  home: ${house.home}
  the list is ${house.integrations} (0600, in the server's half) and is read once at boot: a change applies on restart.
  add refuses a name that is already there unless --replace is passed, and a name is lowercase letters, digits and dashes.
  nothing here prints a secret: a trigger's belongs to the container, and is written by hand until #43.`);
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
		console.log(`${name.padEnd(16)}  ${integration.enabled ? "enabled " : "disabled"}  ${tools}  ${trigger}`);
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

// A refusal from the config module is the operator's message, not a stack trace: the message names the path and the
// entry, which is what a person has to fix.
try {
	if (command === "list") await list();
	else if (command === "add") await add();
	else if (command === "enable") await toggle(true);
	else if (command === "disable") await toggle(false);
	else if (command === "remove") await remove();
	else usage();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}