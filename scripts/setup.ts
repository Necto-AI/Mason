/**
 * `mason setup` — the first run, in one command.
 *
 * `mason onboard` creates a home and then prints the four-step dance that follows it: add an integration, hand-write its
 * `connector` block in `service/integrations.json`, mint a credential, start mason, then go find a connector binary
 * somewhere and run it yourself. That is a first run a stranger cannot finish (#145), and this command is the
 * replacement: pick a connector, answer what it needs, and the entry, the grant, the credential, the compose project and
 * the container all follow from those answers.
 *
 * The shape is a shell over functions that take answers. `runSetup` never reads argv and never prompts; `parseArgs` reads
 * argv; `scripts/wizard.ts` asks the questions this file leaves open. So the same steps run from a terminal, from CI
 * with `--yes`, and from a test — and the interactive path is the one with the least logic in it.
 *
 * What is deliberately not here: the tools face. A connector's MCP endpoint is reachable at `container.port` inside the
 * podman network, and setup publishes no host port (a connector dials out and nothing dials in), so the entry it writes
 * carries the grant and no `tools` block. That arrives with the release that puts mason in the same network.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Capability, ControlOp, ExternalConversation } from "mason-protocol";
import { CONTROL_OPS } from "mason-protocol";
import { catalogEntry, readCatalog } from "../src/server/catalog.ts";
import { composePath, projectName, readComposeCredential, writeCompose } from "../src/server/connector-compose.ts";
import { type ConnectorGrant, listConnectorCredentials, mintConnectorCredential } from "../src/server/connectors.ts";
import { parseRoutines } from "../src/server/hooks.ts";
import { ensureHouse, type HousePaths, housePaths } from "../src/server/house.ts";
import {
	type ConnectorInstall,
	parseSource,
	readInstalls,
	requireInstallable,
	writeInstall,
} from "../src/server/install-state.ts";
import { readIntegrations, writeIntegration } from "../src/server/integrations.ts";
import { bootPolicyFix, checkPodman, listening, loopbackRefusal, up } from "../src/server/podman.ts";
import { DEFAULT_SOUL } from "../src/server/prompt.ts";
import { RETRY_HOOK_ID } from "../src/server/run-retry.ts";
import { CONSOLE, consoleGrant, runChat } from "./chat.ts";
import {
	CONNECTOR_QUESTION,
	CONVERSATIONS_QUESTION,
	choosePrompter,
	EVENTS_QUESTION,
	MissingAnswer,
	OWNER_QUESTION,
	type Prompter,
} from "./wizard.ts";

/**
 * The env whose answer names the conversations the grant allows: `TELEGRAM_ALLOWED_CHATS` today, and any connector that
 * carries words declares one, because a user face needs a room. The convention is documented on `CatalogEnv`.
 */
const CHATS = "_CHATS";

export interface SetupArgs {
	readonly connector?: string;
	readonly url?: string;
	readonly env: ReadonlyMap<string, string>;
	readonly owner?: string;
	/** A `url:` connector's conversations, comma separated. Absent means ask. */
	readonly conversations?: string;
	/** A `url:` connector's event kinds, `kind=hook` pairs comma separated. Absent means ask. */
	readonly events?: string;
	readonly start: boolean;
	readonly yes: boolean;
	readonly chat: boolean;
	readonly help: boolean;
}

export function usage(): string {
	return `usage: mason setup [flags]

  The first run: pick a connector, answer what it needs, and mason writes the integration entry, its grant and its
  credential, generates the connector's compose project and starts it.

  --connector <name>   the connector to install: one from the catalog, \`console\`, or \`custom\`
  --url <ws-url>       a connector already running somewhere else; implies --connector custom
  --env NAME=value     one answer a connector needs; repeatable, and it answers a question so nothing is asked
  --owner <id>         who owns this chat: the id the connector will send for the person mason works for
  --conversations <ids>  a url: connector's conversations, comma separated (default: the owner's)
  --events <kind=hook>   a url: connector's event kinds, comma separated (default: none)
  --no-start           write everything and leave the container down
  --yes                take every flag it has and ask nothing; what CI and a script use
  --chat               open \`mason chat\` when it is done
  --help               this

  A home that already holds this connector's grant is added to, never rewritten, and its credential is reused: a second
  \`mason setup\` rewrites the project only where an answer, the version, the image or the credential changed, and says so.`;
}

/** The hash `mintConnectorCredential` stores: the one thing that says a plaintext is the credential this home holds. */
function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Flags, in the two spellings a person types: `--connector telegram`, and `--env=TELEGRAM_BOT_TOKEN=…`. */
export function parseArgs(argv: readonly string[]): SetupArgs {
	const env = new Map<string, string>();
	let connector: string | undefined;
	let url: string | undefined;
	let owner: string | undefined;
	let conversations: string | undefined;
	let events: string | undefined;
	let start = true;
	let yes = false;
	let chat = false;
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
		switch (flag) {
			case "--connector":
				connector = value();
				break;
			case "--url":
				url = value();
				break;
			case "--owner":
				owner = value();
				break;
			case "--conversations":
				conversations = value();
				break;
			case "--events":
				events = value();
				break;
			case "--env": {
				const answer = value();
				const separator = answer.indexOf("=");
				if (separator <= 0) throw new Error(`--env takes NAME=value, not "${answer}"`);
				env.set(answer.slice(0, separator), answer.slice(separator + 1));
				break;
			}
			case "--no-start":
				start = false;
				break;
			case "--start":
				start = true;
				break;
			case "--yes":
			case "-y":
				yes = true;
				break;
			case "--chat":
				chat = true;
				break;
			case "--help":
			case "-h":
				help = true;
				break;
			default:
				throw new Error(`unknown argument ${arg}; \`mason setup --help\` lists the flags`);
		}
	}
	return {
		...(connector === undefined ? {} : { connector }),
		...(url === undefined ? {} : { url }),
		...(owner === undefined ? {} : { owner }),
		...(conversations === undefined ? {} : { conversations }),
		...(events === undefined ? {} : { events }),
		env,
		start,
		yes,
		chat,
		help,
	};
}

/** The list a person picks from: what this release can install, in the order the catalog ships it. */
export async function connectorChoices(): Promise<readonly Choice[]> {
	const { connectors } = await readCatalog();
	return [
		...connectors.map((entry): Choice => ({ value: entry.name, label: entry.name, description: entry.description })),
		{
			value: CONSOLE,
			label: CONSOLE,
			description: "the terminal, built in: talk to the bot with no Telegram at all",
		},
		{
			value: "custom",
			label: "custom",
			description: "a connector already running somewhere else: pass its ws:// url",
		},
	];
}

interface Choice {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

/**
 * What the grant says for a catalog connector: the owner, the conversations the chat answer names, and the ceiling the
 * catalog declares. A negative chat id is a group or a channel and anything else is a person — the only distinction the
 * Telegram wire carries, and the one `kind` exists to record.
 */
function catalogGrant(
	entry: { readonly capabilities: readonly Capability[]; readonly commands: readonly ControlOp[] },
	owner: string,
	chats: readonly string[],
): ConnectorGrant {
	return {
		user: {
			owner,
			conversations: conversationsOf(owner, chats),
			capabilities: [...entry.capabilities],
		},
		commands: [...entry.commands],
	};
}

/**
 * One conversation of a grant. A negative id is a group or a channel and anything else is a person — the only
 * distinction the Telegram wire carries, and the one `kind` exists to record.
 */
function conversation(id: string): ExternalConversation {
	return { externalConversationId: id, kind: id.startsWith("-") ? "room" : "person" };
}

/** The list a grant names: the answers, or the owner's own room when nothing was answered. */
function conversationsOf(owner: string, ids: readonly string[]): readonly ExternalConversation[] {
	return (ids.length === 0 ? [owner] : ids).map(conversation);
}

/** `a, b, c` as the ids a grant names, trimmed and without the empties a trailing comma leaves. */
function splitIds(text: string): string[] {
	return text
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "");
}

/** The hooks a boot defines: the supervisor's retry, and every routine `agent/routines.json` carries. */
async function assertKnownHooks(paths: HousePaths, events: Record<string, string>): Promise<void> {
	const known = new Set<string>([RETRY_HOOK_ID]);
	const text = await readFile(join(paths.agentDir, "routines.json"), "utf8").catch(() => undefined);
	if (text !== undefined) {
		try {
			for (const routine of parseRoutines(text)) known.add(routine.name);
		} catch {
			// A malformed routines file is the boot's own refusal, with its own message; this check is about the grant.
		}
	}
	const unknown = Object.entries(events).filter(([, hook]) => !known.has(hook));
	if (unknown.length === 0) return;
	throw new Error(
		`${unknown.map(([kind, hook]) => `the kind "${kind}" fires "${hook}"`).join(", ")}, which is not a hook: ` +
			`this build defines ${[...known].map((name) => `"${name}"`).join(", ")}. Nothing was written.`,
	);
}

/**
 * `kind=hook, kind=hook` as the events face's map.
 *
 * Parsed before anything is written, like the url beside it: a pair with no `=` would otherwise become a kind named
 * `kind=hook` and a fire nobody can send, and the refusal names the pair so the typo is the message.
 */
function parseEvents(text: string, where: string): Record<string, string> {
	const hooks: Record<string, string> = {};
	for (const pair of splitIds(text)) {
		const separator = pair.indexOf("=");
		const kind = separator === -1 ? "" : pair.slice(0, separator).trim();
		const hook = separator === -1 ? "" : pair.slice(separator + 1).trim();
		if (kind === "" || hook === "")
			throw new Error(`${where}: "${pair}" is not kind=hook, the event kind and the routine it fires`);
		hooks[kind] = hook;
	}
	return hooks;
}

/** One connector's answers, before anything is written: what the grant says and what the container is handed. */
interface Plan {
	readonly name: string;
	readonly description: string;
	readonly grant: ConnectorGrant;
	readonly source: string;
	readonly image?: string;
	readonly version?: string;
	/** The answers a container gets, in the order they are written into its compose file. */
	readonly env: Readonly<Record<string, string>>;
	/** Whether setup runs a container for it. The console and a `custom` connector run somewhere else. */
	readonly container: boolean;
}

/** Mason's port: the one `mason up` binds, so a container is told where the socket it dials answers. */
function masonPort(): number {
	return Number(process.env.PORT ?? 8787);
}

/** The one question the grant cannot answer for itself, and the line that says what an answer looks like. */
const OWNER = {
	hint: "the id the connector will send for the person mason works for: on Telegram your user id or @username",
	flag: "--owner <id>",
	required: true,
} as const;

/** Every question the chosen connector needs, answered from a flag or from the prompter — and nothing written yet. */
async function plan(args: SetupArgs, prompter: Prompter, paths: HousePaths): Promise<Plan> {
	// `--url` already named the connector it belongs to: a person who passes the address of a running connector has
	// answered "which one", and asking again is the flag lying about what it does.
	const name =
		args.connector ??
		(args.url === undefined ? await prompter.pick(CONNECTOR_QUESTION, await connectorChoices()) : "custom");
	if (name === CONSOLE) {
		// No env, no image, no container: the grant is fixed here and `mason chat` mints its own credential, so setup only
		// records that the door exists.
		return {
			name,
			description: "The terminal, built in: talk to the bot with no Telegram at all",
			grant: consoleGrant(),
			source: `url:ws://127.0.0.1:${masonPort()}/api/connector`,
			env: {},
			container: false,
		};
	}
	if (name === "custom") {
		const url =
			args.url ??
			(await prompter.text("Which connector url?", {
				hint: "the ws:// address of a connector already running somewhere else",
				flag: "--url <ws-url>",
				required: true,
			}));
		// Parsed before anything is written: a typo in the scheme would otherwise become a grant and a credential for a
		// connector that can never open a socket.
		requireInstallable(parseSource(`url:${url}`));
		const owner = args.owner ?? (await prompter.text(OWNER_QUESTION, OWNER));
		// The grant a connector mason does not run is still written here, not by hand (#147): its owner, the conversations
		// it will send, and the kinds it may fire. The wizard asks each one, and each has a flag, so a script answers the
		// same questions a person does.
		const conversations =
			args.conversations !== undefined
				? splitIds(args.conversations)
				: splitIds(
						await prompter.text(CONVERSATIONS_QUESTION, {
							hint: "the ids it will send for its rooms and people, as it sends them; empty means the owner's",
							flag: "--conversations <id,id>",
							fallback: "",
							required: false,
						}),
					);
		const events =
			args.events !== undefined
				? parseEvents(args.events, "--events")
				: parseEvents(
						await prompter.text(EVENTS_QUESTION, {
							hint: "each kind the connector may fire and the routine it wakes, as kind=hook; empty means none",
							flag: "--events <kind=hook,kind=hook>",
							fallback: "",
							required: false,
						}),
						EVENTS_QUESTION,
					);
		// A hook no build defines is a boot that refuses, and it refused *after* this grant was written: the wizard
		// promised a connector the server would not start with, and `mason doctor` said nine ok. The names are the
		// retry hook plus the routines the agent owns, which is exactly what the boot will accept.
		await assertKnownHooks(paths, events);
		return {
			name,
			description: `A connector already running at ${url}`,
			grant: {
				user: { owner, conversations: conversationsOf(owner, conversations) },
				...(Object.keys(events).length === 0 ? {} : { events: { hooks: events } }),
				commands: [...CONTROL_OPS],
			},
			source: `url:${url}`,
			env: {},
			container: false,
		};
	}
	const entry = await catalogEntry(name);
	const answers: Record<string, string> = {};
	for (const variable of entry.env) {
		const fromFlag = args.env.get(variable.name);
		if (fromFlag !== undefined) {
			// An empty flag value is "no answer", which is how an optional variable is declined from a script.
			if (fromFlag !== "") answers[variable.name] = fromFlag;
			continue;
		}
		const optional = variable.optional === true;
		const answer = await prompter.text(variable.name, {
			hint: optional ? `${variable.prompt} (leave it empty to skip)` : variable.prompt,
			flag: `--env ${variable.name}="<${variable.prompt}>"`,
			...(variable.secret === true ? { secret: true } : {}),
			...(optional ? { fallback: "", required: false } : { required: true }),
		});
		if (answer !== "") answers[variable.name] = answer;
	}
	const owner = args.owner ?? (await prompter.text(OWNER_QUESTION, OWNER));
	const chats = Object.entries(answers)
		.filter(([variable]) => variable.endsWith(CHATS))
		.flatMap(([, value]) => value.split(",").map((id) => id.trim()))
		.filter((id) => id !== "");
	return {
		name,
		description: entry.description,
		grant: catalogGrant(entry.connector, owner, chats),
		source: `catalog:${entry.name}@${entry.version}`,
		image: `${entry.image}:${entry.version}`,
		version: entry.version,
		env: answers,
		container: true,
	};
}

/**
 * One connector, end to end: the grant, the credential, the project, the container, the record.
 *
 * The order is the order of the failures it can hit. The grant goes through the writer the boot itself uses, so a bug
 * here refuses here rather than at the next start; the credential exists before the compose file needs its plaintext;
 * the file exists before anything is started from it. And every step asks first, so a second run of the same setup
 * reports what it found instead of rewriting it.
 */
async function install(
	paths: HousePaths,
	plan_: Plan,
	args: SetupArgs,
): Promise<{ readonly credential?: string; readonly started: boolean }> {
	// Every read that can refuse happens before the first write: a broken `config.json` used to be discovered after the
	// grant had landed, which left a connector installed with no credential and a command that exited 1.
	const { integrations } = await readIntegrations(paths);
	const issued = await listConnectorCredentials(paths.home);
	const previous = (await readInstalls(paths)).connectors[plan_.name];
	const existing = integrations[plan_.name];
	const granted = existing?.connector;
	if (granted === undefined) {
		await writeIntegration(paths, plan_.name, {
			...existing,
			enabled: true,
			// An operator's own line survives: it is what the model is told about this integration, and setup is not the
			// thing that knows better.
			description: existing?.description ?? plan_.description,
			connector: plan_.grant,
		});
		console.log(`[setup] wrote the grant for "${plan_.name}" to ${paths.integrations}`);
	} else if (previous?.source !== undefined && previous.source !== plan_.source) {
		// The url lives in the install record, not the grant: a second run with a different `--url` moves it, and a run that
		// did that silently was a wizard reporting success while the connector kept dialling the old address.
		console.log(
			`[setup] "${plan_.name}" is already granted; its address moves: ${previous.source} -> ${plan_.source}`,
		);
	} else {
		console.log(`[setup] "${plan_.name}" is already granted in ${paths.integrations}; the grant is unchanged`);
	}

	let credential: string | undefined;
	const already = issued.find((record) => record.connector === plan_.name);
	if (already === undefined) {
		const minted = await mintConnectorCredential(paths.home, plan_.name, { replace: false });
		credential = minted.credential;
		console.log(`[setup] minted connector credential ${minted.record.id} (stored as a hash in ${paths.config})`);
		console.log(minted.credential);
		console.log("this is the only time it is printed.");
	} else {
		console.log(`[setup] "${plan_.name}" already has connector credential ${already.id}; nothing minted`);
	}

	let started = false;
	/** A start that failed after the files were written: the record goes in, and the failure goes up after it. */
	let failure: unknown;
	if (plan_.container) {
		const path = composePath(paths, plan_.name);
		const project = projectName(paths.home, plan_.name);
		// A container needs the plaintext credential, and mason keeps only a hash. Two of them are usable, and both are
		// proven rather than assumed: a credential minted by this run, or the file's own line when its hash is the hash this
		// home holds (the file is `0600` and this command is about to rewrite it). Anything else is a rotation — revoked,
		// deleted, or rotated elsewhere by `mason connector add --replace` — and the credential nobody holds any more is
		// dropped in the same write, because a container left crash-looping on it is the failure this avoids.
		let plaintext = credential;
		if (plaintext === undefined && already !== undefined) {
			const held = await readComposeCredential(path);
			if (held !== undefined && sha256(held) === already.sha256) plaintext = held;
		}
		if (plaintext === undefined) {
			const rotated = await mintConnectorCredential(paths.home, plan_.name, { replace: true });
			plaintext = rotated.credential;
			console.log(`[setup] no credential this home holds was in ${path}, so one was minted: ${rotated.record.id}`);
			console.log(rotated.credential);
		}
		const written = await writeCompose(paths, {
			connector: plan_.name,
			image: plan_.image ?? "",
			home: paths.home,
			env: {
				MASON_CONNECTOR_URL: `ws://host.containers.internal:${masonPort()}/api/connector`,
				MASON_CONNECTOR_CREDENTIAL: plaintext ?? "",
				...plan_.env,
			},
		});
		if (written.created) console.log(`[setup] wrote ${written.path}`);
		else if (written.changed)
			console.log(
				`[setup] rewrote ${written.path}: an answer, the version, the image or the credential changed; the container is recreated below`,
			);
		else console.log(`[setup] ${written.path} is up to date`);
		if (args.start) {
			// The record is written however this goes: a start that failed still installed the files, and a record that says
			// so is what lets the next run report it rather than believe nothing happened.
			try {
				const address = process.env.HOST ?? "127.0.0.1";
				const refusal = loopbackRefusal(address);
				if (refusal !== undefined) throw new Error(refusal);
				const podman = await checkPodman();
				if (!podman.ok) throw new Error(podman.fix);
				// Not a refusal: the SDK reconnects with backoff, so a container started before the server is a container
				// that connects the moment `mason up` runs. Saying so beats a crash-loop nobody was warned about.
				if (!(await listening("127.0.0.1", masonPort())))
					console.log(
						`[setup] mason is not listening on ${masonPort()} yet: start it with \`mason up\`, and this connector connects then`,
					);
				const output = await up(path, project);
				if (output !== "") console.log(output);
				started = true;
				console.log(`[setup] started project ${project}`);
				// `restart: always` is only half of "it comes back after a reboot", and the other half is a systemd unit no
				// compose file can enable. Said once, with the command, and never again for a machine that has it.
				const boot = await bootPolicyFix();
				if (boot !== undefined) console.log(`[setup] ${boot}`);
			} catch (error) {
				failure = error;
			}
		} else {
			console.log(
				`[setup] --no-start: nothing was started. When mason is up: podman compose -f ${path} -p ${project} up -d`,
			);
		}
	}

	const record: ConnectorInstall = {
		source: plan_.source,
		...(plan_.image === undefined ? {} : { image: plan_.image }),
		...(plan_.version === undefined ? {} : { version: plan_.version }),
		...(plan_.container ? { project: projectName(paths.home, plan_.name) } : {}),
		createdAt: previous?.createdAt ?? new Date().toISOString(),
		// A `--no-start` run says nothing about a container that is already up, so it says nothing: it keeps what the last
		// run recorded rather than reporting it stopped.
		started: args.start ? started : (previous?.started ?? false),
	};
	await writeInstall(paths, plan_.name, record);
	if (failure !== undefined) throw failure;
	return {
		...(credential === undefined ? {} : { credential }),
		started,
	};
}

/**
 * The command. Returns an exit code rather than calling `process.exit`, so a test can run the flow in-process; the guard
 * at the bottom is the only place that turns it into a status.
 */
export async function runSetup(
	argv: readonly string[],
	options: { readonly prompter?: Prompter; readonly house?: HousePaths } = {},
): Promise<number> {
	let args: SetupArgs;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(`[setup] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	if (args.help) {
		console.log(usage());
		return 0;
	}
	let prompter: Prompter | undefined;
	try {
		// Resolved inside the handler: a root with no bot is a refusal with one sentence, not a stack trace.
		const paths = options.house ?? housePaths();
		prompter =
			options.prompter ??
			choosePrompter({
				yes: args.yes,
				...(args.connector === undefined ? {} : { connector: args.connector }),
				...(args.owner === undefined ? {} : { owner: args.owner }),
			});
		console.log(`[setup] home: ${paths.home}`);
		// First, because it makes the two halves and refuses a home from before the split by name: every write below
		// assumes the layout it creates, and a soul it finds is left alone.
		await ensureHouse(paths, DEFAULT_SOUL);
		const plan_ = await plan(args, prompter, paths);
		const outcome = await install(paths, plan_, args);
		console.log("");
		console.log(`[setup] "${plan_.name}" is installed.`);
		if (plan_.container && outcome.started)
			console.log(
				"[setup] next: mason up  — the connector connects when the socket is there, and the project above comes back with the machine",
			);
		else if (plan_.container)
			console.log(
				`[setup] next: mason up  — the connector connects when the socket is there. Start it with: podman compose -f ${composePath(paths, plan_.name)} -p ${projectName(paths.home, plan_.name)} up -d`,
			);
		else if (plan_.name === CONSOLE)
			console.log(`[setup] next: mason chat${paths.fleet === undefined ? "" : ` -b ${paths.fleet.bot}`}`);
		else
			console.log(
				`[setup] next: give the credential above to the connector at ${args.url ?? "its url"}. Its grant names ` +
					`${plan_.grant.user?.conversations.length ?? 0} conversation(s) and ` +
					`${Object.keys(plan_.grant.events?.hooks ?? {}).length} event kind(s): change either with ` +
					`\`mason setup --connector ${plan_.name} --url ${args.url ?? "<url>"} --conversations <ids> ` +
					"--events <kind=hook>`",
			);
		if (outcome.credential !== undefined)
			console.log("[setup] the credential was printed once, above: mason keeps only its hash.");
		if (args.chat) return await runChat([]);
		return 0;
	} catch (error) {
		console.error(`[setup] ${error instanceof Error ? error.message : String(error)}`);
		// A missing answer is not a failure of the install: it is a run that needs a terminal or a flag.
		return error instanceof MissingAnswer ? 2 : 1;
	} finally {
		prompter?.close();
	}
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runSetup(process.argv.slice(2)));
}
