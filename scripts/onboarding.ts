/**
 * `mason onboard` when there is a terminal: seven screens, one plan, and the same commands a script runs.
 *
 * The screens collect answers and nothing else. Nothing here writes a file, mints a credential or starts a container: the
 * plan is built in memory, a person reads it back on the review screen, and the apply screen then runs the operations
 * that already exist — `runInit`, `runNew` (the home only) and `runSetup` — with one answer each in the argv they already
 * take, so the wizard and `mason onboard --yes` cannot drift apart. The operations are handed a prompter that refuses,
 * because the plan answered everything before the first write: a question at that point is a bug in this file, and it
 * fails as one instead of stalling a screen nobody is looking at.
 *
 * Navigation is the flow's, not each screen's. A step returns next, back, cancel, or a jump to another step, and every
 * answer lives in one `Draft` — so going backwards costs a re-render and never a re-answer, and changing the provider
 * clears the model only when the new provider does not offer it. Escape means "back" on every screen after the first,
 * and on the first screen it means "nothing was written", which is true because nothing is written before the apply.
 *
 * What was already done is read from disk, not remembered in a state file. A second run finds the common store, the bot
 * and the grant where the first one left them, skips the questions they answer, and applies only what is missing; an
 * apply that failed halfway resumes the same way, because every step it skips is a step whose artifact is on disk. A
 * temporary file holding half a plan — and a key in it — would be a second source of truth for the same facts.
 */
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { CONTROL_OPS } from "mason-protocol";
import { catalogEntry, readCatalog } from "../src/server/catalog.ts";
import { commonReady, readCommonAuth, readCommonSettings } from "../src/server/common.ts";
import { CONNECTOR_PREFIX } from "../src/server/connectors.ts";
import { type DoctorCheck, runDoctor } from "../src/server/doctor.ts";
import { botPaths, type HousePaths } from "../src/server/house.ts";
import { readInstalls } from "../src/server/install-state.ts";
import { type Integration, readIntegrations } from "../src/server/integrations.ts";
import { checkPodman, listening } from "../src/server/podman.ts";
import { modelIds, openProviders, type ProviderAccess, providerIds, verifyCompletion } from "../src/server/provider.ts";
import { BOT_NAME, botHome, COMMON, type MasonRoot, readRoot, refuseHomeEnv, rootPath } from "../src/server/root.ts";
import { TerminalScreen } from "../src/tui/app.ts";
import type { Choice, StatusRow } from "../src/tui/components.ts";
import { Cancelled, type Screen } from "../src/tui/screen.ts";
import type { Glyphs, Paint } from "../src/tui/style.ts";
import { CONSOLE } from "./chat.ts";
import { parseArgs as parseInitArgs, runInit } from "./init.ts";
import { runNew } from "./new.ts";
import { parseArgs as parseSetupArgs, runSetup } from "./setup.ts";
import { MissingAnswer, type Prompter } from "./wizard.ts";

/** `kind=hook` pairs, as the grant carries them. */
type Events = Record<string, string>;

/** One connector's answers, before anything is written. */
export interface ConnectorPlan {
	readonly kind: string;
	readonly description: string;
	readonly url?: string;
	readonly env: Readonly<Record<string, string>>;
	readonly owner?: string;
	readonly conversations: readonly string[];
	readonly events: Events;
	/** Whether setup runs a container for it: the console and a `custom` connector run somewhere else. */
	readonly container: boolean;
	/** Whether to start it now. Meaningless for the two that run elsewhere. */
	readonly start: boolean;
}

/** Everything the wizard has answered. Absent means "not asked yet": the disk answers what this does not. */
export interface Draft {
	mode?: "quickstart" | "advanced";
	provider?: { readonly id: string; readonly model: string; readonly key?: string };
	agent?: { readonly name: string };
	connector?: ConnectorPlan;
	/** The doctor's answer after the apply, kept for the completion screen. */
	checks?: readonly DoctorCheck[];
	/** The step that failed, when the apply did not finish. */
	failed?: string;
	/** What the person chose on the last screen: whether to hand over to `mason chat`. */
	chat?: boolean;
	/** Which steps a flag answered, so their screens say so instead of asking the same question again. */
	seeded?: { readonly provider?: boolean; readonly connector?: boolean };
}

/** The commands and the disk reads the wizard needs; injected, so a failure is a test and not an outage. */
export interface Operations {
	ready(root: string): Promise<boolean>;
	settings(root: string): Promise<{ readonly provider: string; readonly model: string } | undefined>;
	hasKey(root: string): Promise<boolean>;
	providers(): Promise<ProviderAccess>;
	verify(
		access: ProviderAccess,
		ref: { readonly provider: string; readonly modelId: string },
		key?: string,
	): Promise<string>;
	init(args: readonly string[], root: string, prompter: Prompter): Promise<number>;
	create(name: string, root: string): Promise<number>;
	setup(args: readonly string[], house: HousePaths, prompter: Prompter): Promise<number>;
	doctor(house: HousePaths): Promise<readonly DoctorCheck[]>;
	chat(): Promise<number>;
	podman(): Promise<{ readonly ok: true } | { readonly ok: false; readonly fix: string }>;
	/** Whether mason answers on its port: the one fact that decides whether a conversation can start now. */
	up(): Promise<boolean>;
}

export interface OnboardingOptions {
	/** What `mason onboard` parsed: the bot name and the two halves of its flags, pre-answering the matching questions. */
	readonly bot?: string;
	/** `mason onboard`'s two halves of flags: `--provider/--model/--key`, and `mason setup`'s. */
	readonly init?: readonly string[];
	readonly setup?: readonly string[];
	/** The root override `mason onboard` already took, so a test and the real command read the same one. */
	readonly root?: string;
	readonly screen?: Screen;
	readonly operations?: Operations;
	readonly env?: NodeJS.ProcessEnv;
	/** Injected by a test: the completion screen's "chat now" would otherwise take the terminal for real. */
	readonly handoff?: () => Promise<number>;
}

/**
 * The prompter the operations get: the plan answered everything before the first write, so a question now is a bug.
 *
 * The one exception is an *optional* question, which the plan answered by not answering it — an empty `HTTPS_PROXY`, no
 * conversations of its own. That is the same answer `scriptedPrompter` gives a `--yes` run, so the two paths agree; a
 * required question, or a pick, is a question the plan should have collected, and it fails as a bug in this file.
 */
export function answeredPrompter(): Prompter {
	const refuse = (): never => {
		throw new MissingAnswer("the wizard already answered this before it wrote anything: this is a bug in the flow");
	};
	return {
		pick: refuse,
		text: async (_question, options = {}) => {
			if (options.required === true) refuse();
			return options.fallback ?? "";
		},
		confirm: async (_question, fallback) => fallback,
		close: () => {},
	};
}

/**
 * Whether a page and the decision under it both fit the window.
 *
 * The body gets the window less the frame; the question, its hint and the search line are what a list adds above and
 * below its rows. A summary that pushes the decision off the bottom is a screen with no question on it, and the answer
 * is two screens: the page, then the decision. The count is generous on purpose — one row short is a scroll the person
 * has to discover.
 */
function pageAndChoicesFit(screen: Screen, page: readonly string[], choices: number): boolean {
	return page.length + 6 + choices <= screen.rows - 6;
}

/** The port `mason up` binds, which is what a completion screen asks about. */
function masonPort(): number {
	return Number(process.env.PORT ?? 8787);
}

/** The real operations: the commands, unchanged, and the reads the wizard needs to know what is already there. */
export function realOperations(): Operations {
	return {
		ready: (root) => commonReady(root),
		settings: async (root) => {
			const read = await readCommonSettings(root).catch(() => undefined);
			const settings = read?.value;
			if (settings?.defaultProvider === undefined || settings.defaultModel === undefined) return undefined;
			return { provider: settings.defaultProvider, model: settings.defaultModel };
		},
		hasKey: async (root) => {
			const auth = await readCommonAuth(root).catch(() => undefined);
			return auth !== undefined && Object.keys(auth.providers ?? {}).length > 0;
		},
		providers: () => openProviders({ faux: process.env.PI_FAUX_MODEL === "1" }),
		verify: (access, ref, key) => verifyCompletion(access, ref, key),
		init: (args, root, prompter) => runInit(args, { root, prompter }),
		create: (name, root) => runNew([name], { root, setup: false, doctor: false }),
		setup: (args, house, prompter) => runSetup(args, { house, prompter }),
		doctor: (house) => runDoctor({ house }),
		chat: async () => {
			const { runChat } = await import("./chat.ts");
			return await runChat([]);
		},
		podman: () => checkPodman(),
		up: () => listening("127.0.0.1", masonPort()),
	};
}

/** A direction a step hands back to the driver: the one thing a screen is allowed to decide about the flow. */
type Direction =
	| { readonly go: "next" }
	| { readonly go: "back" }
	| { readonly go: "cancel" }
	| { readonly go: "jump"; readonly to: StepId };

const NEXT: Direction = { go: "next" };
const CANCEL: Direction = { go: "cancel" };

const ORDER = ["welcome", "provider", "agent", "connector", "review", "apply", "done"] as const;
type StepId = (typeof ORDER)[number];

interface Context {
	readonly screen: Screen;
	readonly draft: Draft;
	readonly root: MasonRoot;
	readonly io: Operations;
	readonly flags: { readonly bot?: string; readonly init: readonly string[]; readonly setup: readonly string[] };
	readonly env: NodeJS.ProcessEnv;
}

function look(ctx: Context): { readonly paint: Paint; readonly glyphs: Glyphs } {
	return ctx.screen.look;
}

/** A heading, then `label  value` rows sharing one label column: the shape every summary here has. */
function rows(paint: Paint, title: string, pairs: ReadonlyArray<readonly [string, string]>): string[] {
	const width = Math.max(...pairs.map(([label]) => label.length));
	return [paint.heading(title), ...pairs.map(([label, value]) => `  ${paint.dim(label.padEnd(width))}  ${value}`), ""];
}

/** `--provider opencode-go --model x --key y`, in the spelling `mason init` already parses. */
function initArgs(draft: Draft): string[] {
	const provider = draft.provider;
	if (provider === undefined) return [];
	const args = ["--provider", provider.id, "--model", provider.model];
	if (provider.key !== undefined) args.push("--key", provider.key);
	return args;
}

/** The setup flags a plan is, in the spelling `mason setup` already parses: the argv a script would type. */
function setupArgs(connector: ConnectorPlan): string[] {
	const args = ["--connector", connector.kind];
	if (connector.url !== undefined) args.push("--url", connector.url);
	for (const [name, value] of Object.entries(connector.env)) args.push("--env", `${name}=${value}`);
	if (connector.owner !== undefined && connector.owner !== "") args.push("--owner", connector.owner);
	if (connector.conversations.length > 0) args.push("--conversations", connector.conversations.join(","));
	const events = Object.entries(connector.events).map(([kind, hook]) => `${kind}=${hook}`);
	if (events.length > 0) args.push("--events", events.join(","));
	if (connector.container && !connector.start) args.push("--no-start");
	return args;
}

/** A file path as a person reads it: the home directory as `~`, everything else as it is. */
function short(path: string, env: NodeJS.ProcessEnv): string {
	const home = env.HOME;
	return home !== undefined && home !== "" && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The name a first bot is offered: the login name when it is a legal bot name, and `mason` when it is not. */
function suggestedName(): string {
	let login = "";
	try {
		login = userInfo().username.toLowerCase();
	} catch {
		login = "";
	}
	const cleaned = login.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned !== "" && BOT_NAME.test(cleaned) ? cleaned : "mason";
}

/** Why a bot cannot be called this, or nothing. The same grammar a home directory and a `-b` target use. */
export function botNameProblem(value: string): string | undefined {
	if (!BOT_NAME.test(value)) return "lowercase letters, digits and dashes, starting with a letter or a digit";
	if (value === COMMON) return `"${COMMON}" is the store every bot shares, not a bot`;
	return undefined;
}

/** The ids a comma-separated answer names, without the empties a trailing comma leaves. */
function splitIds(text: string): string[] {
	return text
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "");
}

/** `kind=hook, kind=hook` as the grant carries it, refused here where the person can still correct it. */
function parseEvents(text: string): Events | string {
	const events: Events = {};
	for (const pair of splitIds(text)) {
		const separator = pair.indexOf("=");
		const kind = separator === -1 ? "" : pair.slice(0, separator).trim();
		const hook = separator === -1 ? "" : pair.slice(separator + 1).trim();
		if (kind === "" || hook === "")
			return `"${pair}" is not kind=hook: the event kind, then the routine it wakes, as event=name`;
		events[kind] = hook;
	}
	return events;
}

// ---------------------------------------------------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------------------------------------------------

/** Welcome: what is already here, then the one choice that decides how many questions follow. */
async function welcome(ctx: Context): Promise<Direction> {
	const { screen, root, io, env } = ctx;
	const { paint } = look(ctx);
	const rootExists = existsSync(root.root);
	const checks: StatusRow[] = [
		{
			label: short(root.root, env),
			state: rootExists ? "ok" : "wait",
			detail: rootExists ? "the root exists" : "will be created",
		},
		{ label: "common store", state: "wait", detail: "checking" },
		{ label: "podman", state: "wait", detail: "checking, read-only" },
		{
			label: "bots",
			state: "info",
			detail:
				root.bots.length === 0
					? "none yet: this run creates the first"
					: root.bots.map((bot) => bot.name).join(", "),
		},
	];
	const progress = screen.progress("welcome.checks", "What is here already", checks);
	screen.busy(true);
	const ready = await io.ready(root.root);
	checks[1] = {
		label: "common store",
		state: ready ? "ok" : "info",
		detail: ready ? "already initialised: no provider questions" : "will be created, after the provider answers",
	};
	progress.update(checks);
	const podman = await io.podman();
	checks[2] = podman.ok
		? { label: "podman", state: "ok", detail: "present: a container connector can run here" }
		: {
				label: "podman",
				state: "warn",
				detail: "not usable here: the console works, a container connector will not run",
			};
	progress.update(checks);
	screen.busy(false);
	progress.close();
	const mode = await screen.select(
		"welcome.mode",
		"How would you like to start?",
		[
			{
				value: "quickstart",
				label: "Quickstart",
				description: "the defaults, and only the questions they cannot answer",
			},
			{
				value: "advanced",
				label: "Advanced",
				description: "every answer: the connector's own settings, and whether it starts",
			},
		],
		{
			...(ctx.draft.mode === undefined ? {} : { value: ctx.draft.mode }),
			preface: [
				"mason is one agent, one home, one connector. This run configures the model it thinks with, the home it works in, and the way you talk to it.",
				"",
				paint.dim("Both modes run the same commands; advanced only asks more questions about them."),
			],
		},
	);
	ctx.draft.mode = mode === "advanced" ? "advanced" : "quickstart";
	return NEXT;
}

/** Provider and model: the list, the key, the model, and one completion that says whether the three work together. */
async function provider(ctx: Context): Promise<Direction> {
	const { screen, draft, root, io } = ctx;
	const { paint, glyphs } = look(ctx);
	if (draft.seeded?.provider === true && draft.provider !== undefined) {
		await screen.note("provider.flags", "Model and provider", {
			lines: rows(paint, "Answered on the command line", [
				["provider", draft.provider.id],
				["model", draft.provider.model],
				[
					"key",
					draft.provider.key === undefined ? "none: the offline provider, or the environment" : "given by --key",
				],
			]),
			note: "nothing to ask: the flags answered it",
		});
		return NEXT;
	}
	if (draft.provider === undefined && (await io.ready(root.root))) {
		const settings = await io.settings(root.root);
		const key = await io.hasKey(root.root);
		await screen.note("provider.already", "Model and provider", {
			lines: rows(paint, "Already configured", [
				["model", settings === undefined ? "in common/settings.json" : `${settings.provider}/${settings.model}`],
				["key", key ? "stored in common/auth.json, never shown" : "none: the offline provider, or the environment"],
			]),
			note: "nothing to ask; mason init --provider … --model … is how it changes",
		});
		return NEXT;
	}
	screen.busy(true);
	const access = await io.providers();
	screen.busy(false);
	const known = providerIds(access);
	const id = await screen.select(
		"provider.id",
		"Which provider?",
		known.map((provider) => ({ value: provider, label: provider })),
		{
			hint: "this build's own list, read offline: nothing has been called yet",
			...(draft.provider === undefined ? {} : { value: draft.provider.id }),
		},
	);
	if (!known.includes(id)) throw new Error(`there is no provider "${id}": this build knows ${known.join(", ")}`);
	let key = draft.provider?.id === id ? draft.provider.key : undefined;
	if (!access.faux && key === undefined)
		key = await screen.secret("provider.key", `The ${id} API key`, {
			hint: "it is written to common/auth.json, 0600, and only after the provider answers",
			flag: "--key <key>",
		});
	const models = modelIds(access, id);
	const current = draft.provider?.id === id ? draft.provider.model : undefined;
	const picked = await screen.select(
		"provider.model",
		"Which model?",
		[
			...models.map((model): Choice => ({ value: model, label: model })),
			{ value: "__custom", label: "a model id I type myself", description: "for a model this build does not list" },
		],
		{
			...(current === undefined ? {} : { value: models.includes(current) ? current : "__custom" }),
			hint: `${models.length} model${models.length === 1 ? "" : "s"} this build knows for ${id}; type to filter`,
		},
	);
	const model =
		picked === "__custom"
			? await screen.text("provider.model.custom", "The model id", {
					...(current === undefined || models.includes(current) ? {} : { value: current }),
					hint: `as ${id} spells it; the provider checks it, not this build`,
					flag: "--model <id>",
				})
			: picked;
	draft.provider = { id, model, ...(key === undefined ? {} : { key }) };
	if (access.faux) return NEXT;
	const check = await screen.confirm("provider.check", "Check that this provider answers?", {
		yes: "check it now, with one real completion",
		no: "skip: the install checks it before it writes anything",
	});
	if (!check) return NEXT;
	screen.busy(true);
	try {
		const reply = await io.verify(access, { provider: id, modelId: model }, key);
		screen.busy(false);
		await screen.note("provider.ok", "The provider answered", {
			lines: [
				`${glyphs.ok} ${id}/${model} answered ${JSON.stringify(reply.slice(0, 60))}`,
				"",
				paint.dim("Nothing has been written: the key is held in memory and written only by the install."),
			],
			note: "continue",
		});
		return NEXT;
	} catch (error) {
		screen.busy(false);
		await screen.note("provider.failed", "The provider did not answer", {
			lines: [
				paint.bad(`${glyphs.fail} ${error instanceof Error ? error.message : String(error)}`),
				"",
				"Nothing was stored. Check the key first, then the model id: the install makes the same call before it writes.",
			],
			note: "continue asks for the model again; escape goes back, and writes nothing",
		});
		// The step asks again rather than unwinding: the person is one answer from a working plan, and the screen they
		// need is the one they just left.
		return { go: "jump", to: "provider" };
	}
}

/** Agent: the name, and the one fact about it that matters — where its home goes. */
async function agent(ctx: Context): Promise<Direction> {
	const { screen, draft, root, env } = ctx;
	const { paint } = look(ctx);
	// A root that already holds one bot is a root this run is continuing, so its name is the default: asking again with a
	// blank answer and the login name would quietly install a second home beside the first.
	const only = root.bots.length === 1 ? root.bots[0] : undefined;
	const suggested = draft.agent?.name ?? ctx.flags.bot ?? only?.name ?? suggestedName();
	const name = await screen.text("agent.name", "What should this agent be called?", {
		value: suggested,
		hint:
			only !== undefined && only.name === suggested
				? `this root already has ${only.name}: continuing finishes what it needs`
				: `its home is ${short(botHome(root.root, suggested), env)}; you will talk to it by this name`,
		...(ctx.flags.bot === undefined ? {} : { flag: `-b ${ctx.flags.bot}` }),
		validate: botNameProblem,
	});
	if (draft.mode === "advanced") {
		const home = botHome(root.root, name);
		await screen.note("agent.home", "Where it lives", {
			lines: [
				`${paint.dim("home")}       ${short(home, env)}`,
				`${paint.dim("agent/")}     profile.md, the dated log, skills, workspace, and their git history`,
				`${paint.dim("service/")}   soul.md, integrations.json, the transcript and the fire state`,
				"",
				existsSync(home)
					? paint.warn("that home is already here: its soul, skills and log are kept exactly as they are")
					: paint.dim("nothing here yet: the install creates it whole"),
			],
			note: "the layout is mason's; the name is the only part of it you choose",
		});
	}
	ctx.draft.agent = { name };
	return NEXT;
}

/**
 * The connector a home already grants, when it grants exactly one.
 *
 * A second run is a run about a home that exists, and that home's grant is the answer it already gave: offering it as the
 * default means a resume is enter-enter-enter rather than a choice that silently rewrites it.
 */
async function grantedKind(ctx: Context): Promise<string | undefined> {
	const name = ctx.draft.agent?.name ?? ctx.flags.bot;
	if (name === undefined) return undefined;
	const { integrations } = await readIntegrations(
		botPaths({ root: ctx.root.root, name, home: botHome(ctx.root.root, name) }),
	).catch(() => ({ integrations: {} as Record<string, Integration> }));
	const granted = Object.keys(integrations).filter((key) => integrations[key]?.connector !== undefined);
	return granted.length === 1 ? granted[0] : undefined;
}

/** What a catalog connector's grant says, in words, before the person is asked to grant it. */
async function permissionLines(kind: string): Promise<string[]> {
	const entry = await catalogEntry(kind);
	return [
		`It may carry ${entry.connector.capabilities.join(", ")} replies and send ${entry.connector.commands
			.map((command) => `/${command}`)
			.join(" ")}.`,
		"Nothing else: the grant is written at exactly that ceiling, and the credential it holds belongs to this home.",
	];
}

/** Connector: the kind, then that connector's own questions — and its permissions before its answers. */
async function connector(ctx: Context): Promise<Direction> {
	const { screen, draft, io } = ctx;
	const { paint, glyphs } = look(ctx);
	const advanced = draft.mode === "advanced";
	if (draft.seeded?.connector === true && draft.connector !== undefined) {
		await screen.note("connector.flags", "Connector", {
			lines: rows(paint, "Answered on the command line", [
				["type", draft.connector.kind],
				["owner", draft.connector.owner ?? "(none named)"],
				["starts", draft.connector.start ? "now" : "no: --no-start"],
			]),
			note: "nothing to ask: the flags answered it",
		});
		return NEXT;
	}
	const granted = draft.connector === undefined ? await grantedKind(ctx) : draft.connector.kind;
	const kind = await screen.select("connector.kind", "How will you talk to it?", await connectorChoices(), {
		...(granted === undefined ? {} : { value: granted }),
		hint:
			granted === undefined
				? "the console is built in; a catalog connector runs as a container beside mason"
				: `${granted} is already granted here: choosing it again keeps its grant and its credential`,
	});
	if (kind === CONSOLE) {
		ctx.draft.connector = {
			kind,
			description: "The terminal, built in: talk to the bot with no Telegram at all",
			env: {},
			conversations: [],
			events: {},
			container: false,
			start: false,
		};
		await screen.note("connector.console", "The console connector", {
			lines: [
				"It is built in: mason chat opens the same socket a Telegram bot opens.",
				"No token, no image, no container, and nothing to start.",
			],
			note: "continue builds the plan; the review shows exactly what is granted",
		});
		return NEXT;
	}
	if (kind === "custom") {
		const previous = draft.connector?.kind === "custom" ? draft.connector : undefined;
		const url = await screen.text("connector.url", "Which connector url?", {
			hint: "the ws:// address of a connector that is already running somewhere else",
			...(previous?.url === undefined ? {} : { value: previous.url }),
			placeholder: "ws://127.0.0.1:8083/api/connector",
			flag: "--url <ws-url>",
			validate: (value) =>
				/^wss?:\/\/.+/.test(value) ? undefined : "a ws:// or wss:// address, with a host and a path",
		});
		const owner = await screen.text("connector.owner", "Who owns this chat?", {
			hint: "the id the connector will send for the person mason works for",
			...(previous?.owner === undefined ? {} : { value: previous.owner }),
			flag: "--owner <id>",
		});
		const conversations = advanced
			? splitIds(
					await screen.text("connector.conversations", "Which conversations may it carry?", {
						hint: "the ids it sends for its rooms and people, comma separated; empty means the owner's",
						...(previous === undefined ? {} : { value: previous.conversations.join(", ") }),
						required: false,
						flag: "--conversations <id,id>",
					}),
				)
			: [];
		const raw = advanced
			? await screen.text("connector.events", "Which event kinds may it fire?", {
					hint: "kind=hook pairs, comma separated; empty means none",
					...(previous === undefined
						? {}
						: {
								value: Object.entries(previous.events)
									.map(([event, hook]) => `${event}=${hook}`)
									.join(", "),
							}),
					required: false,
					flag: "--events <kind=hook>",
				})
			: "";
		const events = raw === "" ? {} : parseEvents(raw);
		if (typeof events === "string") throw new Error(events);
		ctx.draft.connector = {
			kind,
			description: `A connector already running at ${url}`,
			url,
			env: {},
			owner,
			conversations,
			events,
			container: false,
			start: false,
		};
		return NEXT;
	}
	const entry = await catalogEntry(kind);
	const previous = draft.connector?.kind === kind ? draft.connector : undefined;
	const podman = await io.podman();
	await screen.note("connector.permissions", "What it may do", {
		lines: [
			`${entry.name}: ${entry.description}`,
			"",
			...(await permissionLines(kind)),
			"",
			`It runs as a container from ${entry.image}:${entry.version}, and comes back when the machine boots.`,
			...(podman.ok ? [] : ["", paint.warn(`${glyphs.warn} ${podman.fix}`)]),
		],
		note: podman.ok
			? "continue asks what it needs"
			: "continue writes the grant, the credential and the project, and starts nothing",
	});
	const answers: Record<string, string> = {};
	for (const variable of entry.env) {
		const given = previous?.env[variable.name];
		if (given !== undefined) {
			answers[variable.name] = given;
			continue;
		}
		const optional = variable.optional === true;
		const chats = variable.name.endsWith("_CHATS");
		const question = chats
			? "Which conversations may it carry?"
			: variable.prompt.charAt(0).toUpperCase() + variable.prompt.slice(1);
		const hint = chats
			? "chat ids or @usernames, comma separated: the rooms and people it may answer in"
			: variable.prompt;
		const answer =
			variable.secret === true
				? await screen.secret(`connector.env.${variable.name}`, question, {
						hint: `${variable.name}: the value goes into the container's environment and nowhere else`,
						flag: `--env ${variable.name}="<${variable.prompt}>"`,
					})
				: await screen.text(`connector.env.${variable.name}`, question, {
						hint: `${hint}${optional ? " · leave it empty to skip" : ""}`,
						required: !optional,
						flag: `--env ${variable.name}="<${variable.prompt}>"`,
					});
		if (answer !== "") answers[variable.name] = answer;
	}
	const owner =
		previous?.owner ??
		(await screen.text("connector.owner", "Who owns this chat?", {
			hint: `on ${entry.name} that is the id it sends for the person mason works for, such as your user id or @username`,
			flag: "--owner <id>",
		}));
	const chats = Object.entries(answers)
		.filter(([name]) => name.endsWith("_CHATS"))
		.flatMap(([, value]) => splitIds(value));
	const start =
		advanced && podman.ok
			? await screen.confirm("connector.start", "Start it now?", {
					yes: "start the container, and it comes back after a reboot",
					no: "write everything and leave it down",
				})
			: podman.ok;
	ctx.draft.connector = {
		kind,
		description: entry.description,
		env: answers,
		owner,
		conversations: chats,
		events: {},
		container: true,
		start,
	};
	return NEXT;
}

/**
 * What a connector's grant allows, as the review reads it back.
 *
 * The catalog is the ceiling for a connector mason runs, and the protocol's own control set is the ceiling for the
 * console. A `custom` connector is granted the owner's conversations and every control, because setup has nothing else to
 * narrow it with: saying so is better than an empty line.
 */
async function grantedLines(kind: string): Promise<string[]> {
	const controls = CONTROL_OPS.map((command) => `/${command}`).join(" ");
	if (kind === CONSOLE) return [`the terminal's words, with ${controls}`];
	if (kind === "custom") return [`the conversations it names, with ${controls}`];
	const entry = await catalogEntry(kind).catch(() => undefined);
	if (entry === undefined) return [];
	return [
		`${entry.connector.capabilities.join(", ")} replies`,
		entry.connector.commands.map((command) => `/${command}`).join(" "),
	];
}

/** The catalog's connectors, the built-in console, and a connector that is already running somewhere else. */
async function connectorChoices(): Promise<readonly Choice[]> {
	const { connectors } = await readCatalog();
	return [
		...connectors.map((entry): Choice => ({ value: entry.name, label: entry.name, description: entry.description })),
		{
			value: CONSOLE,
			label: CONSOLE,
			description: "the terminal, built in: no token, no container, works the moment mason is up",
		},
		{
			value: "custom",
			label: "custom",
			description: "a connector that is already running somewhere else: it needs its ws:// address",
		},
	];
}

/** Review: everything the plan will write, and the way back to any answer that is wrong. */
async function review(ctx: Context): Promise<Direction> {
	const { screen, draft, root, env } = ctx;
	const { paint } = look(ctx);
	const name = draft.agent?.name ?? "";
	const home = name === "" ? "(unchosen)" : short(botHome(root.root, name), env);
	const settings = draft.provider === undefined ? await ctx.io.settings(root.root) : undefined;
	// The provider screen has something to ask only when the store does not answer it, or when a flag already did: an
	// entry that leads to a note saying "nothing to ask" is a dead end dressed as a choice.
	const canChangeProvider = draft.provider !== undefined || !(await ctx.io.ready(root.root));
	const connectorPlan = draft.connector;
	const lines: string[] = [
		"Nothing has been written yet. This is what will be.",
		"",
		...rows(paint, "Agent", [
			["name", name === "" ? "(unchosen)" : name],
			["home", home],
		]),
		...rows(paint, "Provider and model", [
			[
				"model",
				draft.provider === undefined
					? settings === undefined
						? "the store's current model"
						: `${settings.provider}/${settings.model}`
					: `${draft.provider.id}/${draft.provider.model}`,
			],
			[
				"key",
				draft.provider?.key === undefined ? "the store's key, never shown" : "a new key, stored once it answers",
			],
		]),
	];
	const connectorPairs: Array<readonly [string, string]> = [["type", connectorPlan?.kind ?? "(unchosen)"]];
	if (connectorPlan?.url !== undefined) connectorPairs.push(["url", connectorPlan.url]);
	if (connectorPlan?.owner !== undefined) connectorPairs.push(["owner", connectorPlan.owner]);
	if ((connectorPlan?.conversations.length ?? 0) > 0)
		connectorPairs.push(["chats", (connectorPlan?.conversations ?? []).join(", ")]);
	const events = Object.entries(connectorPlan?.events ?? {});
	if (events.length > 0)
		connectorPairs.push(["events", events.map(([event, hook]) => `${event} → ${hook}`).join(", ")]);
	if (connectorPlan?.container === true)
		connectorPairs.push(["starts", connectorPlan.start ? "now, and after a reboot" : "no: written and left down"]);
	// What the grant allows, on the screen that asks for it: the connector step explained it before the answers, and the
	// review is where a person reads the whole thing back.
	const may = connectorPlan === undefined ? [] : await grantedLines(connectorPlan.kind);
	if (may.length > 0) connectorPairs.push(["may", may.join("; ")]);
	lines.push(...rows(paint, "Connector", connectorPairs));
	lines.push(
		...rows(paint, "Install", [
			["store", draft.provider === undefined ? "unchanged" : "written, after the provider answers"],
			["home", existsSync(botHome(root.root, name)) ? "already there, kept as it is" : "created"],
			[
				"connector",
				connectorPlan?.container === true ? "grant, credential, compose project" : "grant and credential",
			],
			["checks", "mason doctor: nine read-only checks"],
		]),
		paint.dim("A bot token and a credential are in this plan. Neither is shown on this screen."),
	);
	// Two screens in a short window, one in a tall one: a plan longer than the window would put the decision below the
	// fold, and a person cannot be asked a question they cannot see. The scroll view still scrolls the summary.
	const choices = [
		{ value: "apply", label: "install it", description: "four steps, then the checks" },
		...(canChangeProvider ? [{ value: "provider", label: "change the provider or model" }] : []),
		{ value: "agent", label: "change the agent name" },
		{ value: "connector", label: "change the connector" },
		{ value: "cancel", label: "leave without writing anything" },
	];
	const fits = pageAndChoicesFit(screen, lines, choices.length);
	if (!fits) await screen.note("review.read", "The plan", { lines, note: "continue decides what to do with it" });
	const action = await screen.select("review.action", "Apply this plan?", choices, {
		...(fits ? { preface: lines } : {}),
		hint: "escape goes back to the connector; nothing is written until you choose install it",
	});
	if (action === "cancel") return CANCEL;
	if (action === "apply") return NEXT;
	return { go: "jump", to: action === "provider" ? "provider" : action === "agent" ? "agent" : "connector" };
}

/** One plan step the apply screen runs: the command, why it may already be done, and what it leaves behind if it fails. */
interface ApplyStep {
	readonly id: string;
	readonly label: string;
	/** Said when the disk already answers it. */
	readonly done?: string;
	/** Said when it fails: what is on disk now, read off what the operation itself printed. */
	committed(log: readonly string[]): string;
	run(): Promise<void>;
}

/** The plan as steps, in the order their failures happen: the store, the home, the connector, the checks. */
function applySteps(ctx: Context, house: () => HousePaths): ApplyStep[] {
	const { draft, io, root } = ctx;
	const steps: ApplyStep[] = [];
	if (draft.provider !== undefined)
		steps.push({
			id: "store",
			label: "provider and model",
			committed: (log) =>
				log.some((line) => line.includes("wrote") && line.includes("settings.json"))
					? "The store was written"
					: "Nothing was written: the store goes in as one commit, after the provider answers",
			run: async () => {
				const code = await io.init(initArgs(draft), root.root, answeredPrompter());
				if (code !== 0) throw new Error("the provider did not answer, so nothing was stored");
			},
		});
	const name = draft.agent?.name;
	if (name !== undefined)
		steps.push({
			id: "agent",
			label: "agent home",
			...(existsSync(botHome(root.root, name)) ? { done: "already there, kept" } : {}),
			committed: (log) =>
				log.some((line) => line.includes("created bot"))
					? "The home was created"
					: "Nothing was written: a home is created whole",
			run: async () => {
				const code = await io.create(name, root.root);
				if (code !== 0) throw new Error("the home was not created");
			},
		});
	const connectorPlan = draft.connector;
	if (connectorPlan !== undefined)
		steps.push({
			id: "connector",
			label: connectorPlan.container
				? connectorPlan.start
					? "connector, credential and container"
					: "connector, credential and project"
				: "connector and credential",
			committed: (log) =>
				log.some((line) => line.includes("wrote the grant") || line.includes("minted connector credential"))
					? "The grant and the credential were written before anything was started; mason doctor reads what is there"
					: "Nothing was written",
			run: async () => {
				const code = await io.setup(setupArgs(connectorPlan), house(), answeredPrompter());
				if (code !== 0) throw new Error("the connector was not installed");
			},
		});
	if (name !== undefined)
		steps.push({
			id: "doctor",
			label: "checks",
			committed: () => "The install itself is complete: only the checks did not run",
			run: async () => {
				draft.checks = await io.doctor(house());
			},
		});
	return steps;
}

/**
 * Take `console.log`/`console.error` for the length of one operation, so its own words land on the progress screen
 * instead of through the middle of the frame.
 *
 * The rendering path never goes through `console`: the alternate screen writes to the terminal directly. That is what
 * makes this safe across an `await`, and it is why the operations need no progress callback of their own — the lines
 * they already print are the progress.
 */
export function capture(sink: (line: string) => void): () => void {
	const log = console.log;
	const error = console.error;
	const write = (...parts: unknown[]): void => {
		const line = parts.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
		if (line.trim() === "") return;
		sink(line);
	};
	console.log = write;
	console.error = write;
	return () => {
		console.log = log;
		console.error = error;
	};
}

/**
 * A credential, and the line that follows it, are the one thing a progress screen must not repaint.
 *
 * `mason setup` prints a freshly minted credential exactly once, on purpose: it is the only moment the plaintext exists,
 * and the person is meant to copy it. That moment is the apply screen's problem, not its content — the same run put the
 * plaintext into the connector's compose file — so the line becomes a sentence saying it happened, and the screen a
 * person leaves on the terminal does not carry a live credential into a scrollback buffer.
 */
export function redact(line: string): string {
	const bare = line.replace(/^\[\w+\]\s*/, "").trim();
	if (bare.startsWith(CONNECTOR_PREFIX) || /^[A-Za-z0-9_-]{43,}$/.test(bare))
		return "a credential was minted: mason setup prints it once, and this screen does not keep it";
	if (bare === "this is the only time it is printed.") return "";
	return bare;
}

/** The last thing an operation said that belongs on its row: the progress, not the preamble. */
function detail(log: readonly string[]): string | undefined {
	for (let index = log.length - 1; index >= 0; index -= 1) {
		const line = redact(log[index] ?? "");
		if (line !== "") return line;
	}
	return undefined;
}

/** The last few things an operation said, for the failure pane, redacted, in the order they were printed. */
function tail(log: readonly string[], count = 4): string[] {
	return log
		.map(redact)
		.filter((line) => line !== "")
		.slice(-count);
}

/** Apply: the four operations, their own progress on the screen, and what is on disk if one of them fails. */
async function apply(ctx: Context): Promise<Direction> {
	const { screen, draft, root } = ctx;
	const { paint, glyphs } = look(ctx);
	const name = draft.agent?.name ?? "";
	const house = (): HousePaths => botPaths({ root: root.root, name, home: botHome(root.root, name) });
	const steps = applySteps(ctx, house);
	const states = new Map<string, StatusRow["state"]>(steps.map((step) => [step.id, "wait"]));
	const logs = new Map<string, string[]>();
	const rowsNow = (): StatusRow[] =>
		steps.map((step) => {
			const state = states.get(step.id) ?? "wait";
			const line = state === "skip" ? step.done : detail(logs.get(step.id) ?? []);
			return { label: step.label, state, ...(line === undefined ? {} : { detail: line }) };
		});
	const progress = screen.progress("apply.steps", "What it is doing", rowsNow());
	let failure: { readonly step: ApplyStep; readonly message: string } | undefined;
	for (;;) {
		screen.busy(true);
		failure = undefined;
		for (const step of steps) {
			const state = states.get(step.id);
			if (state === "ok" || state === "skip") continue;
			if (step.done !== undefined && state === "wait") {
				states.set(step.id, "skip");
				progress.update(rowsNow());
				continue;
			}
			states.set(step.id, "run");
			progress.update(rowsNow());
			const log: string[] = [];
			logs.set(step.id, log);
			const restore = capture((line) => {
				log.push(line);
				progress.update(rowsNow());
			});
			try {
				await step.run();
				states.set(step.id, "ok");
			} catch (error) {
				states.set(step.id, "fail");
				failure = { step, message: error instanceof Error ? error.message : String(error) };
			} finally {
				restore();
			}
			progress.update(rowsNow());
			if (failure !== undefined) break;
		}
		screen.busy(false);
		if (failure === undefined) break;
		progress.update(rowsNow(), `${glyphs.fail} ${failure.step.label} failed`);
		const key = await progress.key([
			{ key: "r", label: "retry what failed" },
			{ key: "enter", label: "stop here" },
		]);
		if (key !== "r") break;
		// Only the failed step runs again: everything above it is on disk, and the rows say so.
		states.set(failure.step.id, "wait");
	}
	progress.close();
	if (failure === undefined) return NEXT;
	draft.failed = failure.step.label;
	await screen.note("apply.failed", "Not finished", {
		lines: [
			paint.bad(`${glyphs.fail} ${failure.step.label}: ${failure.message}`),
			"",
			...tail(logs.get(failure.step.id) ?? []).map((line) => paint.dim(line)),
			"",
			paint.dim(failure.step.committed(logs.get(failure.step.id) ?? [])),
			"mason doctor reads the result, and running mason onboard again picks up where this stopped.",
		],
		note: "continue to the summary",
	});
	return NEXT;
}

/** Done: what is configured, what runs, what answered — and the one action worth taking next. */
async function done(ctx: Context): Promise<Direction> {
	const { screen, draft, root, env } = ctx;
	const { paint } = look(ctx);
	const name = draft.agent?.name ?? "";
	const home = botHome(root.root, name);
	const paths = botPaths({ root: root.root, name, home });
	const checks = draft.checks ?? [];
	const granted = await readIntegrations(paths)
		.then(({ integrations }) => Object.keys(integrations).filter((key) => integrations[key]?.connector !== undefined))
		.catch(() => []);
	const started = await readInstalls(paths)
		.then(({ connectors }) =>
			Object.entries(connectors)
				.filter(([, record]) => record.started)
				.map(([key]) => key),
		)
		.catch(() => []);
	const up = await ctx.io.up();
	const failed = draft.failed;
	const server = checks.find((check) => check.name === "server");
	const lines = [
		...(failed === undefined
			? [paint.ok(`${look(ctx).glyphs.ok} installed`)]
			: [paint.bad(`${look(ctx).glyphs.fail} ${failed} failed: see the note above`)]),
		"",
		...rows(paint, "What is there now", [
			["agent", existsSync(home) ? short(home, env) : "no home"],
			["grants", granted.length === 0 ? "none" : granted.join(", ")],
			[
				"running",
				up
					? `mason answers on ${masonPort()}`
					: started.length > 0
						? `${started.join(", ")} started, mason is not up`
						: "mason is not up yet",
			],
			[
				"verified",
				checks.length === 0
					? "the checks did not run"
					: checks.every((check) => check.ok)
						? `${checks.length} of ${checks.length} checks passed`
						: checks
								.filter((check) => !check.ok)
								.map((check) => `${check.name}: ${check.detail}`)
								.join("; "),
			],
		]),
	];
	if (draft.connector?.container === false && draft.connector.kind !== CONSOLE)
		lines.push(
			paint.dim(`it needs a credential: mason connector add ${draft.connector.kind} --replace prints one, once`),
			"",
		);
	if (!up) lines.push(paint.dim(`next: mason up -b ${name}, then mason chat -b ${name}`), "");
	if (server !== undefined && !server.ok && up === false) lines.push(paint.dim(server.detail), "");
	// The same rule the review has: a summary longer than the window would put the decision below the fold.
	const fits = pageAndChoicesFit(screen, lines, up ? 2 : 1);
	if (!fits) await screen.note("done.read", "The summary", { lines, note: "continue for the next step" });
	const action = await screen.select(
		"done.action",
		"What next?",
		up
			? [
					{
						value: "chat",
						label: "start chatting",
						description: "mason chat, right here, through the built-in console",
					},
					{ value: "finish", label: "finish", description: `later: mason chat -b ${name}` },
				]
			: [{ value: "finish", label: "finish", description: `then: mason up -b ${name}` }],
		{
			...(fits ? { preface: lines } : {}),
			hint: up ? "the conversation takes this terminal" : "nothing else is needed: mason is configured",
		},
	);
	ctx.draft.chat = action === "chat";
	return NEXT;
}

// ---------------------------------------------------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------------------------------------------------

type Step = (ctx: Context) => Promise<Direction>;

const STEPS: Record<StepId, Step> = { welcome, provider, agent, connector, review, apply, done };

/** The section each step's screens carry in the frame: the question is the body's first line, this is above it. */
const SECTIONS: Record<StepId, string> = {
	welcome: "Welcome",
	provider: "Model and provider",
	agent: "Agent",
	connector: "Connector",
	review: "Review",
	apply: "Installing",
	done: "Done",
};

/** The pre-answers `mason onboard` flags are: a flag answers its question, so no screen asks it again. */
export function preseed(flags: { readonly init: readonly string[]; readonly setup: readonly string[] }): {
	readonly provider?: Draft["provider"];
	readonly connector?: Draft["connector"];
	readonly seeded?: Draft["seeded"];
} {
	const init = parseInitArgs(flags.init);
	const setup = parseSetupArgs(flags.setup);
	const draft: {
		provider?: Draft["provider"];
		connector?: Draft["connector"];
		seeded?: Draft["seeded"];
	} = {};
	if (init.provider !== undefined && init.model !== undefined)
		draft.provider = { id: init.provider, model: init.model, ...(init.key === undefined ? {} : { key: init.key }) };
	if (setup.connector !== undefined || setup.url !== undefined) {
		const events = setup.events === undefined ? {} : parseEvents(setup.events);
		draft.connector = {
			kind: setup.connector ?? "custom",
			description: "",
			...(setup.url === undefined ? {} : { url: setup.url, kind: "custom" }),
			env: Object.fromEntries(setup.env),
			...(setup.owner === undefined ? {} : { owner: setup.owner }),
			conversations: setup.conversations === undefined ? [] : splitIds(setup.conversations),
			events: typeof events === "string" ? {} : events,
			container: (setup.connector ?? "") !== "" && setup.connector !== CONSOLE && setup.connector !== "custom",
			start: setup.start,
		};
	}
	if (draft.provider !== undefined || draft.connector !== undefined)
		draft.seeded = {
			...(draft.provider === undefined ? {} : { provider: true }),
			...(draft.connector === undefined ? {} : { connector: true }),
		};
	return draft;
}

/**
 * The command. Returns an exit code rather than calling `process.exit`, so a test drives the whole wizard in-process.
 *
 * 0 is "the plan was applied", 2 is "cancelled, nothing written" — the code `mason setup` already uses for a missing
 * answer — and 1 is a failed apply that the person stopped on rather than retried.
 */
export async function runOnboarding(options: OnboardingOptions): Promise<number> {
	refuseHomeEnv(options.env);
	const root = readRoot(options.root ?? rootPath());
	const flags = {
		...(options.bot === undefined ? {} : { bot: options.bot }),
		init: options.init ?? [],
		setup: options.setup ?? [],
	};
	const seed = preseed(flags);
	const draft: Draft = { ...seed };
	const io = options.operations ?? realOperations();
	let live = options.screen;
	try {
		if (live === undefined) live = TerminalScreen.open({ subtitle: "first run" });
		const ctx: Context = { screen: live, draft, root, io, flags, env: options.env ?? process.env };
		let index = 0;
		while (index < ORDER.length) {
			const id = ORDER[index] as StepId;
			live.where({ title: SECTIONS[id], index: index + 1, total: ORDER.length });
			let direction: Direction;
			try {
				direction = await STEPS[id](ctx);
			} catch (error) {
				if (!(error instanceof Cancelled)) throw error;
				// Escape means back, on every screen but the first: there is a previous answer to return to, and nothing has
				// been written, so going back is the cheap thing to offer. On the first screen there is nothing behind it,
				// and cancelling is what the footer promised.
				direction = index === 0 ? CANCEL : { go: "back" };
			}
			if (direction.go === "cancel") return 2;
			if (direction.go === "back") index = Math.max(0, index - 1);
			else if (direction.go === "next") index += 1;
			else index = ORDER.indexOf(direction.to);
		}
		if (draft.failed !== undefined) return 1;
		// The install is complete, but a check that fails is the same answer the scripted run gives: exit 1, and the
		// summary above says which check and what repairs it.
		if ((draft.checks ?? []).some((check) => !check.ok)) return 1;
		if (draft.chat === true) {
			// The conversation owns the terminal from here: the wizard releases it first, and names the bot for it the same
			// way `bin/mason.ts` turns `-b` into `MASON_BOT` for every verb.
			live.close();
			if (draft.agent !== undefined) process.env.MASON_BOT = draft.agent.name;
			const handoff = options.handoff ?? io.chat;
			return await handoff();
		}
		return 0;
	} catch (error) {
		console.error(`[onboard] ${error instanceof Error ? error.message : String(error)}`);
		return error instanceof MissingAnswer ? 2 : 1;
	} finally {
		live?.close();
	}
}
