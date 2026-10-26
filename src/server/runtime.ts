/**
 * Durable harness bootstrap: SQLite storage, model access (real providers or the faux provider),
 * the extension registry, the `pi-env` execution split, and the root conversation.
 */
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	AgentDoc,
	type Conversation,
	type ConversationId,
	type ConversationView,
	createRegistry,
	type Extension,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	type Registry,
	type Storage,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodemode } from "./extensions/codemode.ts";
import { createRuntimeEnvManager, sshTargetFromEnv, type RuntimeEnvManager } from "./env.ts";
import { Delivery } from "./extensions/delivery.ts";
import { Memory } from "./extensions/memory.ts";
import { GenerateSandboxedUiExtension } from "./extensions/sandboxed-ui.ts";
import { DEFAULT_SOUL, Prompt } from "./prompt.ts";
import { configureHouse, ensureHouse, ensureRepository, housePaths } from "./house.ts";
import { currentIntegrations, type Integration, readIntegrations, setIntegrations } from "./integrations.ts";
import { connectIntegrations, type McpTransportFactory } from "./mcp.ts";
import { builtinHooks, HooksManager } from "./hooks.ts";
import { readRoster } from "./roster.ts";

/**
 * The extensions every conversation gets unless it says otherwise. `delivery` is unconditional: it is the only way the
 * agent reaches the reader, so no conversation may be without it.
 *
 * Code mode and the MCP tools are not here: `openAgentRuntime` builds both per boot, because each owns something that
 * dies with the runtime — a QuickJS sandbox and one client socket per integration — and a module constant would outlive
 * the process's use of it.
 */
export const BASE_EXTENSIONS: readonly Extension[] = [
	CodingTools,
	// The one extension with sections: every section of the prompt is declared in `prompt.ts`, in order.
	Prompt,
	Memory,
	Delivery,
	// Always on: the client renders a widget whenever one arrives, so hiding the tool protected nothing and a tool list
	// that changes between turns breaks the prompt cache.
	GenerateSandboxedUiExtension,
	// Also always on, and inert while nothing is deferred: with no MCP tools loaded and no other deferred tool, it has
	// nothing to find. Installed rather than added when something arrives, so the tool list does not grow a second time
	// when an integration connects.
	createToolSearchExtension(),
];

/**
 * The names of every extension a boot installs whatever the conversation's stored selection says: `BASE_EXTENSIONS`,
 * then what this boot built for itself — `mcp` when it reached a tools face, `codemode` always.
 *
 * It is exported because it is the answer to a question a test asks: a stored selection is repaired with exactly these,
 * and a list written down a second time in a test would go on passing after a base extension was added to the array.
 * The extra extensions a caller installs are not here: they are the caller's to select, and only these are
 * unconditional.
 */
export function unconditionalExtensionNames(perBoot: readonly string[]): readonly string[] {
	return [...BASE_EXTENSIONS.map((extension) => extension.name), ...perBoot];
}

export interface AgentModelRef {
	provider: string;
	modelId: string;
}

/**
 * The conversation view while it is being watched: the latest revision, and each later one, as a Chord resource
 * subscribes to it. A `conversation.watch()` handle observes through one listener only, so this is where the fan-out
 * lives.
 */
export interface ConversationState {
	/** The latest revision; the acquisition one until a commit arrives. */
	readonly value: ConversationView;
	/** The current view, then every later revision. */
	subscribe(listener: (view: ConversationView) => void): () => void;
	/** Stop the watch; the last value stays readable. Idempotent. */
	dispose(): Promise<void>;
}

export interface AgentRuntime {
	readonly harness: Harness;
	readonly rootId: ConversationId;
	/** Where this process's state lives; the agent's home by default, not the directory it was started from. */
	readonly dataDir: string;
	readonly hooks: HooksManager;
	readonly env: RuntimeEnvManager;
	readonly workspaceDir: string;
	readonly model: AgentModelRef;
	/** `false` when the model access is the offline faux provider, so the UI can say so. */
	readonly modelIsFaux: boolean;
	conversation(): Promise<Conversation>;
	/** The view, watched until `dispose()`: what the Chord resource mirrors into the client's cells. */
	viewState(context: Context): Promise<ConversationState>;
	/** One committed read of the view, leaving no watch behind: what `/api/status` asks for. */
	viewSnapshot(context: Context): Promise<ConversationView>;
	close(): Promise<void>;
}

export interface OpenAgentRuntimeOptions {
	/**
	 * Where `agent.sqlite` and `hooks.json` live. Defaults to `MASON_DATA`, else `<home>/service/data`.
	 *
	 * It used to default to `.data` in the current directory, which meant the agent's state was a property of the shell
	 * it was started from: two checkouts ran two agents, a script run from a copy read the conversation in the copy,
	 * and a throwaway server could open the real transcript. The state belongs to the home, so it lives in the home.
	 */
	readonly dataDir?: string;
	/** Model access built by the caller (tests script the faux provider); default `resolveModelAccess`. */
	readonly modelAccess?: ResolvedModel;
	readonly workspaceDir?: string;
	/** Where `~/.mason` is; tests point it at a temporary directory. */
	readonly houseHome?: string;
	/** `memory` keeps everything in RAM: tests and throwaway runs. */
	readonly storage?: "sqlite" | "memory";
	readonly storageOverride?: Storage;
	/** Model choices; overridden by `PI_PROVIDER` / `PI_MODEL` / `PI_FAUX_MODEL`. */
	readonly model?: AgentModelRef;
	/** `true` (or `PI_FAUX_MODEL=1`) plays the model offline: deterministic tests and UI checks. */
	readonly faux?: boolean;
	readonly env?: RuntimeEnvManager;
	readonly onReport?: (error: unknown) => void;
	/** Installed in addition to the base extensions. */
	readonly extensions?: readonly Extension[];
	/**
	 * What the root conversation selects, when something other than the whole installed set should run.
	 *
	 * Tests and evals install a tool and then want the conversation without `coding-tools`, so a stub can stand in for
	 * `bash` without the real one being offered too.
	 */
	readonly selection?: readonly Extension[];
	/**
	 * Whether to append missing base extensions to a stored explicit selection. Default true, because `delivery` must
	 * never be absent from a real conversation; tests and evals turn it off when a narrowed selection is the point.
	 */
	readonly repairBase?: boolean;
	/**
	 * How the boot reaches an integration's MCP endpoint. Tests hand in one end of an in-memory pair, so no test dials a
	 * port; production leaves it out and the client speaks Streamable HTTP to the url in `service/integrations.json`.
	 */
	readonly mcpTransport?: McpTransportFactory;
	readonly settings?: HarnessSettings;
}

const FAUX_MODEL: AgentModelRef = { provider: "faux", modelId: "faux-1" };

/** `settings.json`'s `defaultProvider` / `defaultModel`, as pi's own CLI reads them. */
function storedDefaultModel(): AgentModelRef | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const settings = parsed as { defaultProvider?: unknown; defaultModel?: unknown };
		if (typeof settings.defaultProvider !== "string" || typeof settings.defaultModel !== "string") return undefined;
		return { provider: settings.defaultProvider, modelId: settings.defaultModel };
	} catch {
		return undefined;
	}
}

export interface ResolvedModel {
	readonly models: Models;
	readonly ref: AgentModelRef;
	readonly faux: boolean;
}

export async function resolveModelAccess(options: OpenAgentRuntimeOptions): Promise<ResolvedModel> {
	const env = process.env;
	if (options.faux === true || env.PI_FAUX_MODEL === "1") {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider as Provider);
		return { models, ref: options.model ?? FAUX_MODEL, faux: true };
	}
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	const ref =
		options.model ??
		(env.PI_PROVIDER !== undefined && env.PI_MODEL !== undefined
			? { provider: env.PI_PROVIDER, modelId: env.PI_MODEL }
			: storedDefaultModel());
	if (ref === undefined) {
		throw new Error(
			"No model configured: set defaultProvider/defaultModel in ~/.pi/agent/settings.json, or PI_PROVIDER/PI_MODEL",
		);
	}
	return { models: runtime, ref, faux: false };
}

/** Opens storage, the harness, and the root conversation; resumes any run a previous process left unfinished. */
export async function openAgentRuntime(
	context: Context,
	options: OpenAgentRuntimeOptions = {},
): Promise<AgentRuntime> {
	// The agent's home: its soul, its profile, its log, its skills, its state, and the directory it works in, in the two
	// halves the deployment mounts separately. Created once, and never overwritten. The workspace is its own directory,
	// not the code's: an agent that can edit the program that runs it is a different product.
	const house = configureHouse(housePaths(options.houseHome));
	await ensureHouse(house, DEFAULT_SOUL);
	// The integration list, once, before anything can run: the tool surface and the prompt section are decided at boot,
	// and a file that cannot be read is refused here rather than leaving the process with fewer tools than the operator
	// configured and no way to notice.
	setIntegrations((await readIntegrations(house)).integrations);
	// The tools face of every enabled integration, reached here and nowhere else: `install()` publishes immediately and
	// `selectExtensions` runs on every preparation, so a deferred list that was settled after the harness opened would be
	// a surface that could still change under a running turn. A boot with no tools face connects nothing.
	const mcp = await connectIntegrations({
		integrations: currentIntegrations(),
		...(options.mcpTransport === undefined ? {} : { openTransport: options.mcpTransport }),
	});
	// Code mode, per boot rather than in BASE_EXTENSIONS: its sandbox is permanent once closed, so one instance shared
	// across boots would refuse the next runtime in the same process. It is the other way the model reaches a tool it
	// was not offered (`tool_search` is the first), and the one that can read a whole result.
	const codemode = createCodemode();
	// Everything below opens something that outlives the line that made it — a hook timer, a socket to an MCP server, a
	// sandbox, an execution daemon — and a boot that refuses must not leave any of it running. There is one list, written
	// in the order things were opened, and the success path and the unwind path both close it in reverse: a resource
	// cannot be added to one and missed in the other, because there is only one. The extension repair used to be the only
	// failure with something already open; now the whole body is caught, so a throw anywhere after the MCP clients exist
	// closes them instead of leaking them for the life of the process.
	const opened: Array<() => Promise<void>> = [() => mcp.close(), () => codemode.close()];
	const reportClose = options.onReport ?? ((error: unknown) => console.error("[runtime] a close failed", error));
	try {
		// The history lives with the files it is about, in `agent/`: that is the half the tool machine mounts, so `remember`
		// commits there from the same machine the log is written on.
		await ensureRepository(house.agentDir);
		const workspaceDir = options.workspaceDir ?? house.workspaceDir;
		const dataDir = options.dataDir ?? process.env.MASON_DATA ?? house.dataDir;

		// The hooks manager exists before the harness opens, because a trigger that fires a hook no build defines has to
		// refuse the boot before anything can run: the door names one hook, so a name that is not a hook is a door that would
		// accept a delivery and drop it. This is config, not health — a missing hook is fatal whatever the container's own
		// `required` says.
		const hooks = new HooksManager({
			conversation: () => harness.root(BACKGROUND_CONTEXT),
			statePath: options.storage === "memory" ? undefined : join(dataDir, "hooks.json"),
			...(options.onReport === undefined ? {} : { onReport: options.onReport }),
		});
		opened.push(() => hooks.close());
		// What kind of bot this is, for the one builtin template that speaks to a person's world: a home with one name in
		// its roster works for that person, and the team-chat text has to say so or every instruction reads as an outside
		// system asking. The roster is a file, so this is read where the hooks are defined and nowhere later.
		const roster = await readRoster(house);
		const sole = roster.people.length === 1 ? roster.people[0]?.name : undefined;
		for (const hook of builtinHooks(sole === undefined ? {} : { person: sole })) hooks.define(hook);
		assertTriggersHaveHooks(currentIntegrations(), hooks, house.integrations);

		const storage =
			options.storageOverride ??
			(options.storage === "memory" ? new MemoryStorage() : await openSqliteStorage(join(dataDir, "agent.sqlite")));

		const { models, ref, faux } = options.modelAccess ?? (await resolveModelAccess(options));

		const extensionList: readonly Extension[] = [
			...BASE_EXTENSIONS,
			...(options.extensions ?? []),
			...(mcp.extension === undefined ? [] : [mcp.extension]),
			codemode.extension,
		];
		const unconditional = unconditionalExtensionNames([
			...(mcp.extension === undefined ? [] : [mcp.extension.name]),
			codemode.extension.name,
		]);
		const registry: Registry = createRegistry();
		for (const extension of extensionList) registry.install(extension);

		const envManager =
			options.env ??
			createRuntimeEnvManager({
				workspaceDir,
				...(sshTargetFromEnv() === undefined ? {} : { ssh: sshTargetFromEnv() }),
			});
		opened.push(() => envManager.close());

		const settings: HarnessSettings = {
			...options.settings,
			// Admission: only the user's steer cuts in, and queued follow-ups drain as one turn — the model prioritises
			// between them, because nothing here can rank a fired hook against a wish the reader typed.
			followUpMode: options.settings?.followUpMode ?? "all",
			steeringMode: options.settings?.steeringMode ?? "one-at-a-time",
			// An always-on agent idles past the provider's five-minute window constantly; the long retention is what stops
			// every wake-up from re-paying for the whole prefix.
			stream: { ...options.settings?.stream, cacheRetention: options.settings?.stream?.cacheRetention ?? "long" },
			extensions: options.selection ?? extensionList,
		};

		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				settings,
				env: async (target) => envManager.envFor({ conversationId: String(target.conversationId), cwd: target.cwd }),
				...(options.onReport === undefined ? {} : { onReport: options.onReport }),
			},
			context,
		);
		// From here the boot has a harness to close too: a throw in the root, in the extension repair or in `resume` unwinds
		// past an open harness, and leaving it to the process's exit would keep its storage and its timers for the life of a
		// process that never served.
		opened.push(() => harness.close(BACKGROUND_CONTEXT));

		const root = await harness.root(context, {
			agent: { model: ref, cwd: workspaceDir, extensions: options.selection ?? extensionList },
		});
		// Before anything can run: a stored selection is used verbatim, so a doc written before a base extension existed —
		// or before an integration offered tools — would leave the conversation without it, while `/api/integrations` said it
		// had connected. A failed repair is a failed guarantee, so the server does not start with it.
		if (options.repairBase !== false) await appendMissingExtensions(root, unconditional, context);
		hooks.start();
		// Picks up a run the last process left unfinished.
		harness.resume();

		return {
			harness,
			rootId: root.id,
			dataDir,
			hooks,
			env: envManager,
			workspaceDir,
			model: ref,
			modelIsFaux: faux,
			conversation: () => Promise.resolve(root),
			viewState: (viewContext) => watchConversation(root, viewContext),
			viewSnapshot: (viewContext) => readConversation(root, viewContext),
			async close() {
				// The same list the refused boot walks, in the same order, so the two cannot drift.
				await closeOpened(opened, reportClose);
			},
		};
	} catch (error) {
		// In the reverse of the order they were opened — the harness, the execution daemon, the hooks, the sandbox, the MCP
		// clients — so a refused boot leaves nothing running behind the throw it unwinds from, and that throw is the one the
		// operator sees: a close that fails is reported, never thrown in its place.
		await closeOpened(opened, reportClose);
		throw error;
	}
}

/**
 * Closes every opener on `opened`, newest first.
 *
 * Every opener runs even when an earlier one failed, and a closer's error is reported through `report` rather than thrown:
 * on a refused boot the reason is the boot's own error, and a close error thrown here would replace it with a story about
 * tidying up, while on shutdown a throw would be the last thing the caller heard about a process already going quiet.
 * `report` is `options.onReport` when the caller has one — the channel its harness and hooks already report on — and
 * `console.error` otherwise, so a failed close is reported, not silenced.
 */
async function closeOpened(opened: readonly (() => Promise<void>)[], report: (error: unknown) => void): Promise<void> {
	for (const close of [...opened].reverse()) {
		try {
			await close();
		} catch (error) {
			report(error);
		}
	}
}

/**
 * Watch `conversation`'s view for as long as the returned state is alive: one watch, started at acquisition, handed to
 * every subscriber in turn. Subscribing delivers the current view first, the way the replicated state it replaces
 * hydrated its listeners.
 */
async function watchConversation(conversation: Conversation, context: Context): Promise<ConversationState> {
	const watch = await conversation.watch(context);
	const listeners = new Set<(view: ConversationView) => void>();
	watch.start(async (view) => {
		for (const listener of [...listeners]) listener(view);
	});
	return {
		get value() {
			return watch.value;
		},
		subscribe(listener) {
			listeners.add(listener);
			listener(watch.value);
			return () => listeners.delete(listener);
		},
		async dispose() {
			listeners.clear();
			await watch.stop();
		},
	};
}

/** Read the view once: the acquisition revision of a watch that is stopped before it can deliver anything. */
async function readConversation(conversation: Conversation, context: Context): Promise<ConversationView> {
	const watch = await conversation.watch(context);
	const value = watch.value;
	await watch.stop();
	return value;
}

/**
 * Append the unconditional extension names a stored explicit selection lacks, in the order they are given.
 *
 * These are the base extensions plus, on a boot that reached one, the MCP tools, and code mode: no conversation may be
 * without `delivery`, and a conversation whose stored array predates any of them — an array is used verbatim — would
 * otherwise keep the tool out of reach while the route reported the integration connected. The stored order is kept and
 * nothing is pruned. An unset or `{ add, remove }` selection already unions with the settings, so it needs nothing.
 */
async function appendMissingExtensions(
	root: Conversation,
	unconditional: readonly string[],
	context: Context,
): Promise<void> {
	await root.commit(async (tx) => {
		const stored = (await tx.doc(AgentDoc, root.id)).extensions;
		if (!Array.isArray(stored)) return;
		const missing = unconditional.filter((name) => !stored.includes(name));
		if (missing.length > 0) stored.push(...missing);
	}, context);
}

async function openSqliteStorage(path: string): Promise<Storage> {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	const storage = await openNodeSqliteStorage(path);
	// SQLite creates the file with the process umask; the transcript inside it deserves the same 0600 as the config.
	try {
		chmodSync(path, 0o600);
	} catch {
		// No modes on this filesystem; nothing to set.
	}
	return storage;
}

/**
 * A trigger's hook is a name in a file, so a build that does not define it must refuse rather than start.
 *
 * Only enabled integrations are checked: a disabled one's door answers `404`, and a name is not a reason to keep an
 * integration the operator switched off from ever being switched on again. The message names the file, the integration
 * and the hook, because all three are what a person has to change.
 */
function assertTriggersHaveHooks(
	integrations: Record<string, Integration>,
	hooks: HooksManager,
	path: string,
): void {
	for (const [name, integration] of Object.entries(integrations)) {
		if (!integration.enabled) continue;
		const hook = integration.trigger?.hook;
		if (hook === undefined || hooks.has(hook)) continue;
		throw new Error(
			`${path}: integration "${name}" has a trigger that fires "${hook}", which is not a hook. A delivery there ` +
				"would fire nothing, so the server does not start with one.",
		);
	}
}
