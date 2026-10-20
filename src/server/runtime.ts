/**
 * Durable harness bootstrap: SQLite storage, model access (real providers or the faux provider),
 * the extension registry, the `pi-env` execution split, and the root conversation.
 */
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttachedReplicatedState, Context } from "@earendil-works/chord";
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
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRuntimeEnvManager, sshTargetFromEnv, type RuntimeEnvManager } from "./env.ts";
import { Delivery } from "./extensions/delivery.ts";
import { Memory } from "./extensions/memory.ts";
import { GenerateSandboxedUiExtension } from "./extensions/sandboxed-ui.ts";
import { DEFAULT_SOUL, Prompt } from "./prompt.ts";
import { configureHouse, ensureHouse, ensureRepository, housePaths } from "./house.ts";
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
];

export interface AgentModelRef {
	provider: string;
	modelId: string;
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
	viewState(context: Context): Promise<AttachedReplicatedState<ConversationView>>;
	close(): Promise<void>;
}

export interface OpenAgentRuntimeOptions {
	/**
	 * Where `agent.sqlite` and `hooks.json` live. Defaults to `MASON_DATA`, else `<home>/data`.
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
	// The agent's home: its soul, its profile, its log, its skills, its state, and the directory it works in.
	// Created once, and never overwritten. The workspace is its own directory, not the code's: an agent that can edit
	// the program that runs it is a different product.
	const house = configureHouse(housePaths(options.houseHome));
	await ensureHouse(house, DEFAULT_SOUL);
	await ensureRepository(house.home);
	const workspaceDir = options.workspaceDir ?? house.workspaceDir;
	const dataDir = options.dataDir ?? process.env.MASON_DATA ?? house.dataDir;

	const storage =
		options.storageOverride ??
		(options.storage === "memory" ? new MemoryStorage() : await openSqliteStorage(join(dataDir, "agent.sqlite")));

	const { models, ref, faux } = options.modelAccess ?? (await resolveModelAccess(options));

	const extensionList: readonly Extension[] = [...BASE_EXTENSIONS, ...(options.extensions ?? [])];
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
	// Before anything can run: a stored selection is used verbatim, so a doc written before a base extension existed
	// would leave the conversation without it. A failed repair is a failed guarantee, so the server does not start
	// with it — but it also does not start with the hooks and the env manager left open.
	try {
		if (options.repairBase !== false) await appendMissingBaseExtensions(root, context);
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
		viewState: (viewContext) => root.viewState(viewContext),
		async close() {
			await hooks.close();
			await harness.close(BACKGROUND_CONTEXT);
			await envManager.close();
		},
	};
}

/**
 * Return the base extensions a stored explicit selection lacks, appended in `BASE_EXTENSIONS` order.
 *
 * Only `BASE_EXTENSIONS` are unconditional, and no conversation may be without `delivery`, so a `pi.agent` doc that
 * predates one of them — an array is used verbatim — gets it back on open. The stored order is kept and nothing is
 * pruned. An unset or `{ add, remove }` selection already unions with the settings, so it needs nothing.
 */
async function appendMissingBaseExtensions(root: Conversation, context: Context): Promise<void> {
	await root.commit(async (tx) => {
		const stored = (await tx.doc(AgentDoc, root.id)).extensions;
		if (!Array.isArray(stored)) return;
		const missing = BASE_EXTENSIONS.filter((extension) => !stored.includes(extension.name));
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
