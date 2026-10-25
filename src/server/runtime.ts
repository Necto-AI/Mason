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
import { createRuntimeEnvManager, sshTargetFromEnv, type RuntimeEnvManager } from "./env.ts";
import { Delivery } from "./extensions/delivery.ts";
import { Memory } from "./extensions/memory.ts";
import { GenerateSandboxedUiExtension } from "./extensions/sandboxed-ui.ts";
import { DEFAULT_SOUL, Prompt } from "./prompt.ts";
import { configureHouse, ensureHouse, ensureRepository, housePaths } from "./house.ts";
import { currentIntegrations, readIntegrations, setIntegrations } from "./integrations.ts";
import { connectIntegrations, type McpTransportFactory } from "./mcp.ts";
import { builtinHooks, HooksManager } from "./hooks.ts";

/**
 * The extensions every conversation gets unless it says otherwise. `delivery` is unconditional: it is the only way the
 * agent reaches the reader, so no conversation may be without it.
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
	// nothing to find, and it is the only way the model reaches a tool it was not offered. Installed rather than added
	// when something arrives, so the tool list does not grow a second time when an integration connects.
	createToolSearchExtension(),
];

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
	// The history lives with the files it is about, in `agent/`: that is the half the tool machine mounts, so `remember`
	// commits there from the same machine the log is written on.
	await ensureRepository(house.agentDir);
	const workspaceDir = options.workspaceDir ?? house.workspaceDir;
	const dataDir = options.dataDir ?? process.env.MASON_DATA ?? house.dataDir;

	const storage =
		options.storageOverride ??
		(options.storage === "memory" ? new MemoryStorage() : await openSqliteStorage(join(dataDir, "agent.sqlite")));

	const { models, ref, faux } = options.modelAccess ?? (await resolveModelAccess(options));

	const extensionList: readonly Extension[] = [
		...BASE_EXTENSIONS,
		...(options.extensions ?? []),
		...(mcp.extension === undefined ? [] : [mcp.extension]),
	];
	// What a stored explicit selection is repaired with. The extra extensions a caller installs are not: they are the
	// caller's to select, and only these are unconditional.
	const unconditionalExtensions: readonly Extension[] = [
		...BASE_EXTENSIONS,
		...(mcp.extension === undefined ? [] : [mcp.extension]),
	];
	const registry: Registry = createRegistry();
	for (const extension of extensionList) registry.install(extension);

	const envManager =
		options.env ??
		createRuntimeEnvManager({
			workspaceDir,
			...(sshTargetFromEnv() === undefined ? {} : { ssh: sshTargetFromEnv() }),
		});

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

	const hooks = new HooksManager({
		conversation: () => harness.root(BACKGROUND_CONTEXT),
		statePath: options.storage === "memory" ? undefined : join(dataDir, "hooks.json"),
		...(options.onReport === undefined ? {} : { onReport: options.onReport }),
	});
	for (const hook of builtinHooks()) hooks.define(hook);

	const root = await harness.root(context, {
		agent: { model: ref, cwd: workspaceDir, extensions: options.selection ?? extensionList },
	});
	// Before anything can run: a stored selection is used verbatim, so a doc written before a base extension existed —
	// or before an integration offered tools — would leave the conversation without it, while `/api/integrations` said it
	// had connected. A failed repair is a failed guarantee, so the server does not start with it — but it also does not
	// start with the hooks and the env manager left open.
	try {
		if (options.repairBase !== false) await appendMissingExtensions(root, unconditionalExtensions, context);
	} catch (error) {
		await hooks.close();
		await envManager.close();
		throw error;
	}
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
			await hooks.close();
			await harness.close(BACKGROUND_CONTEXT);
			await envManager.close();
		},
	};
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
 * Return the unconditional extensions a stored explicit selection lacks, appended in the order they are given.
 *
 * These are the base extensions plus, on a boot that reached one, the MCP tools: no conversation may be without
 * `delivery`, and a conversation whose stored array predates either one — an array is used verbatim — would otherwise
 * keep the tool out of reach while the route reported the integration connected. The stored order is kept and nothing
 * is pruned. An unset or `{ add, remove }` selection already unions with the settings, so it needs nothing.
 */
async function appendMissingExtensions(
	root: Conversation,
	unconditional: readonly Extension[],
	context: Context,
): Promise<void> {
	await root.commit(async (tx) => {
		const stored = (await tx.doc(AgentDoc, root.id)).extensions;
		if (!Array.isArray(stored)) return;
		const missing = unconditional.filter((extension) => !stored.includes(extension.name));
		if (missing.length > 0) stored.push(...missing.map((extension) => extension.name));
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
