/**
 * `mason setup` — the first run, in one command.
 *
 * `mason onboard` creates a home and then prints the four-step dance that follows it: add an integration, hand-write its
 * `connector` block in `service/integrations.json`, mint a credential, start mason, then go find a connector binary
 * somewhere and run it yourself. That is a first run a stranger cannot finish (#145), and this command is the
 * replacement: pick a connector, answer what it needs, and the entry, the grant, the credential, the compose project and
 * the container all follow from those answers.
 *
 * The shape is a shell over a plan. `parseArgs` reads argv, `ask` gathers the answers, `src/setup/plan.ts` decides what
 * they imply, `src/setup/apply.ts` writes it and starts what it asks for, and this file prints the result and returns an
 * exit code: nothing is decided between the plan and the write, which is what makes the plan something a caller can read
 * before anything is applied, and the install testable without podman. `scripts/wizard.ts` asks the questions `ask`
 * leaves open, so the same steps run from a terminal, from CI with `--yes`, and from a test.
 *
 * What is deliberately not here: the MCP server. A connector's MCP endpoint is reachable at `container.port` inside the
 * podman network, and setup publishes no host port (a connector dials out and nothing dials in), so the entry it writes
 * carries the grant and no `tools` block. That arrives with the release that puts mason in the same network.
 */
import { catalogEntry, readCatalog } from "../src/server/catalog.ts";
import { ensureHouse, type HousePaths, housePaths } from "../src/server/house.ts";
import { parseSource, requireInstallable } from "../src/server/install-state.ts";
import { DEFAULT_SOUL } from "../src/server/prompt.ts";
import { applyPlan } from "../src/setup/apply.ts";
import { type ConnectorAnswers, masonPort, planConnector } from "../src/setup/plan.ts";
import { podmanRunner } from "../src/setup/runner.ts";
import { CONSOLE, CONSOLE_DESCRIPTION, consoleGrant, runChat } from "./chat.ts";
import {
	CONNECTOR_QUESTION,
	choosePrompter,
	EVENTS_QUESTION,
	MissingAnswer,
	OWNER_QUESTION,
	type Prompter,
} from "./wizard.ts";

/**
 * One connector's answers on the command line: the flags from its `--connector` up to the next one.
 *
 * A repeated `--connector` is a second connector, and `--url`/`--env`/`--owner`/`--events`/`--no-start` belong to the
 * connector they follow — which is what `mason onboard --connector telegram --owner @me --connector console` promises.
 * The same fields sit on `SetupArgs` for the last of them, so everything that reads one connector reads as it did.
 */
export interface SetupConnector {
	readonly connector?: string;
	readonly url?: string;
	readonly env: ReadonlyMap<string, string>;
	readonly owner?: string;
	/** A `url:` connector's event kinds, `kind=hook` pairs comma separated. Absent means ask. */
	readonly events?: string;
	readonly start: boolean;
}

export interface SetupArgs extends SetupConnector {
	/** Every connector the command line names, in the order it was written: one install each, on one home. */
	readonly connectors: readonly SetupConnector[];
	readonly yes: boolean;
	readonly chat: boolean;
	readonly help: boolean;
}

export function usage(): string {
	return `usage: mason setup [flags]

  The first run: pick a connector, answer what it needs, and mason writes the integration entry, its grant and its
  credential, generates the connector's compose project and starts it.

  --connector <name>   the connector to install: one from the catalog, \`console\`, or \`custom\`. Repeat it to install a
                       second one, in the order written
  --url <ws-url>       a connector already running somewhere else; implies --connector custom
  --env NAME=value     one answer a connector needs; repeatable, and it answers a question so nothing is asked
  --owner <id>         who owns this chat: the id the connector will send for the person mason works for
  --events <kind=hook>   a url: connector's event kinds, comma separated (default: none)
  --no-start           write everything and leave the container down
  --yes                take every flag it has and ask nothing; what CI and a script use
  --chat               open \`mason chat\` when it is done
  --help               this

  A home that already holds this connector's grant is added to, never rewritten, and its credential is reused: a second
  \`mason setup\` rewrites the project only where an answer, the version, the image or the credential changed, and says so.`;
}

/** One connector's answers while the command line is being read: the same shape `SetupConnector` ends up as. */
interface Segment {
	connector?: string;
	url?: string;
	env: Map<string, string>;
	owner?: string;
	events?: string;
	start: boolean;
}

const segment = (): Segment => ({ env: new Map(), start: true });

/** Flags, in the two spellings a person types: `--connector telegram`, and `--env=TELEGRAM_BOT_TOKEN=…`. */
export function parseArgs(argv: readonly string[]): SetupArgs {
	// A flag belongs to the `--connector` it follows, so the argv is read as segments and not as one set of answers: the
	// segment already open takes the first `--connector`, and every one after it opens another.
	const segments: Segment[] = [segment()];
	const current = (): Segment => segments[segments.length - 1] as Segment;
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
			case "--connector": {
				const name = value();
				if (current().connector === undefined) current().connector = name;
				else segments.push({ ...segment(), connector: name });
				break;
			}
			case "--url":
				current().url = value();
				break;
			case "--owner":
				current().owner = value();
				break;
			case "--targets":
			case "--conversations":
				// A retired spelling, refused with the rule rather than as unknown: a script that used it yesterday
				// reads why it is gone. `test/setup.test.ts` pins the sentence.
				throw new Error(
					`${flag} named a place to be sent to; a send goes back to the connector that carried the words, so a grant names faces and event kinds only`,
				);
			case "--events":
				current().events = value();
				break;
			case "--env": {
				const answer = value();
				const separator = answer.indexOf("=");
				if (separator <= 0) throw new Error(`--env takes NAME=value, not "${answer}"`);
				// `NAME=` is how a script says "no answer", which is the same thing as not passing the flag: the connector's
				// question is still open, and setup asks it.
				if (answer.slice(separator + 1) !== "")
					current().env.set(answer.slice(0, separator), answer.slice(separator + 1));
				break;
			}
			case "--no-start":
				current().start = false;
				break;
			case "--start":
				current().start = true;
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
		...current(),
		connectors: segments,
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

/** `a, b, c` as the ids a grant names, trimmed and without the empties a trailing comma leaves. */
export function splitIds(text: string): string[] {
	return text
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "");
}

/**
 * `kind=hook, kind=hook` as the events face's map.
 *
 * Parsed before anything is written, like the url beside it: a pair with no `=` would otherwise become a kind named
 * `kind=hook` and a fire nobody can send, and the refusal names the pair so the typo is the message. `where` is the flag
 * the text came from, so the message can name the one the person typed.
 */
export function parseEvents(text: string, where: string): Record<string, string> {
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

/** The one question the grant cannot answer for itself, and the line that says what an answer looks like. */
const OWNER = {
	hint: "the id the connector will send for the person mason works for: on Telegram your user id or @username",
	flag: "--owner <id>",
	required: true,
} as const;

/**
 * Every question the chosen connector needs, answered from a flag or from the prompter — and nothing written yet.
 *
 * What is here is the command's business: which question to ask, which flag answers it, and which value is not an answer
 * at all. What the answers *mean* — the grant, the source, the image, the project — is the planner's.
 */
async function ask(one: SetupConnector, prompter: Prompter): Promise<ConnectorAnswers> {
	// `--url` already named the connector it belongs to: a person who passes the address of a running connector has
	// answered "which one", and asking again is the flag lying about what it does.
	const name =
		one.connector ??
		(one.url === undefined ? await prompter.pick(CONNECTOR_QUESTION, await connectorChoices()) : "custom");
	if (name === CONSOLE) {
		// No env, no image, no container: the grant is fixed beside the process that serves it (`scripts/chat.ts`), and
		// `mason chat` mints its own credential, so setup only records that the door exists.
		return {
			kind: "fixed",
			name,
			description: CONSOLE_DESCRIPTION,
			grant: consoleGrant(),
			source: `url:ws://127.0.0.1:${masonPort()}/api/connector`,
		};
	}
	if (name === "custom") {
		const url =
			one.url ??
			(await prompter.text("Which connector url?", {
				hint: "the ws:// address of a connector already running somewhere else",
				flag: "--url <ws-url>",
				required: true,
			}));
		// Parsed before anything is written: a typo in the scheme would otherwise become a grant and a credential for a
		// connector that can never open a socket — and asked about before the owner, so a bad address costs one answer.
		requireInstallable(parseSource(`url:${url}`));
		const owner = one.owner ?? (await prompter.text(OWNER_QUESTION, OWNER));
		// The grant a connector mason does not run is still written here, not by hand (#147): its owner and the kinds it
		// may fire. The wizard asks each one, and each has a flag, so a script answers the same questions a person does.
		const events =
			one.events !== undefined
				? parseEvents(one.events, "--events")
				: parseEvents(
						await prompter.text(EVENTS_QUESTION, {
							hint: "each kind the connector may fire and the routine it wakes, as kind=hook; empty means none",
							flag: "--events <kind=hook,kind=hook>",
							fallback: "",
							required: false,
						}),
						EVENTS_QUESTION,
					);
		return { kind: "url", name, url, owner, events };
	}
	const entry = await catalogEntry(name);
	const env: Record<string, string> = {};
	for (const variable of entry.env) {
		const fromFlag = one.env.get(variable.name);
		if (fromFlag !== undefined) {
			// An empty flag value is "no answer", which is how an optional variable is declined from a script.
			if (fromFlag !== "") env[variable.name] = fromFlag;
			continue;
		}
		const optional = variable.optional === true;
		const answer = await prompter.text(variable.name, {
			hint: optional ? `${variable.prompt} (leave it empty to skip)` : variable.prompt,
			flag: `--env ${variable.name}="<${variable.prompt}>"`,
			...(variable.secret === true ? { secret: true } : {}),
			...(optional ? { fallback: "", required: false } : { required: true }),
		});
		if (answer !== "") env[variable.name] = answer;
	}
	const owner = one.owner ?? (await prompter.text(OWNER_QUESTION, OWNER));
	return { kind: "catalog", name, env, owner };
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
		// One connector per `--connector`, in the order they were written: each one is its own grant, credential and
		// project, and stopping at the first failure is what makes the error the thing a person fixes.
		for (const one of args.connectors) {
			const plan = await planConnector(await ask(one, prompter), paths);
			const applied = await applyPlan(plan, { runner: podmanRunner, start: one.start });
			for (const note of applied.notes) console.log(note.kind === "advice" ? `[setup] ${note.text}` : note.text);
			// The record is in and the files are there either way: a start that failed is a container to fix, not an
			// install to repeat, and this is where the command says so.
			if (applied.failure !== undefined) throw applied.failure;
			console.log("");
			console.log(`[setup] "${plan.name}" is installed.`);
			if (plan.project !== undefined && applied.started)
				console.log(
					"[setup] next: mason up  — the connector connects when the socket is there, and the project above comes back with the machine",
				);
			else if (plan.project !== undefined)
				console.log(
					`[setup] next: mason up  — the connector connects when the socket is there. Start it with: podman compose -f ${plan.project.composeFile} -p ${plan.project.name} up -d`,
				);
			else if (plan.name === CONSOLE)
				console.log(`[setup] next: mason chat${paths.fleet === undefined ? "" : ` -b ${paths.fleet.bot}`}`);
			else
				console.log(
					`[setup] next: give the credential above to the connector at ${one.url ?? "its url"}. Its grant names ` +
						`${Object.keys(plan.grant.events?.hooks ?? {}).length} event kind(s): change them with ` +
						`\`mason setup --connector ${plan.name} --url ${one.url ?? "<url>"} --events <kind=hook>\``,
				);
			if (applied.credential === "minted")
				console.log("[setup] the credential was printed once, above: mason keeps only its hash.");
		}
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
