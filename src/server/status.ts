/**
 * What the client shows about the agent: everything is derived from committed state
 * (`docs["pi.live"]`, `docs["pi.inbox"]`, `docs["pi.agent"]`) plus the app's own switches.
 */
import type { ConversationView } from "@earendil-works/pi-durable";
import type { InboxState, LiveState } from "@earendil-works/pi-durable";
import type { AgentStatus, HookSummary, RunStatus } from "../shared/contract.ts";

export function liveOf(view: ConversationView | undefined): LiveState | undefined {
	return view?.docs["pi.live"] as LiveState | undefined;
}

export function inboxOf(view: ConversationView | undefined): InboxState | undefined {
	return view?.docs["pi.inbox"] as InboxState | undefined;
}

/** `true` while the conversation is working on an input; `pi.live.run` exists exactly then. */
export function isBusy(view: ConversationView | undefined): boolean {
	return liveOf(view)?.run !== undefined;
}

export function countTools(view: ConversationView | undefined): { running: number; total: number } {
	const tools = liveOf(view)?.tools ?? [];
	return { running: tools.filter((tool) => tool.status !== "done").length, total: tools.length };
}

/** The names of the tools the running round has not finished. Names only — never arguments, never output. */
export function runningToolNames(view: ConversationView | undefined): string[] {
	const names: string[] = [];
	for (const tool of liveOf(view)?.tools ?? []) {
		if (tool.status === "done") continue;
		if (!names.includes(tool.name)) names.push(tool.name);
	}
	return names;
}

/** The hook data an `app.hook` entry carries. */
export function hookData(entry: { data?: unknown }): {
	hookId: string;
	hookName: string;
	firedAt: string;
	payload: string | null;
} {
	const data = (entry.data ?? {}) as { hookId?: unknown; hookName?: unknown; firedAt?: unknown; payload?: unknown };
	return {
		hookId: typeof data.hookId === "string" ? data.hookId : "",
		hookName: typeof data.hookName === "string" ? data.hookName : "event",
		firedAt: typeof data.firedAt === "string" ? data.firedAt : "",
		payload: typeof data.payload === "string" ? data.payload : null,
	};
}

export function queuedSubmissions(view: ConversationView | undefined): number {
	return inboxOf(view)?.items.length ?? 0;
}

/**
 * One run status for the whole conversation. Precedence follows what the user must know first:
 * a retry backoff outranks running tools, tools outrank the generation that waits for them,
 * and a compaction only shows while nothing else does.
 */
export function deriveRunStatus(view: ConversationView | undefined): RunStatus {
	const live = liveOf(view);
	if (live === undefined) return "idle";
	if (live.generation?.retry !== undefined) return "retrying";
	if (live.tools?.some((tool) => tool.status !== "done") === true) return "running_tools";
	if (live.compactions !== undefined && live.compactions.length > 0) return "compacting";
	if (live.generation !== undefined) return "generating";
	return "idle";
}

export interface DeriveStatusOptions {
	hooks: HookSummary[];
	sandboxedUiEnabled: boolean;
	model?: { provider: string; modelId: string };
	cwd?: string;
}

export function deriveAgentStatus(view: ConversationView | undefined, options: DeriveStatusOptions): AgentStatus {
	const live = liveOf(view);
	const runTaskId = live?.run?.taskId;
	return {
		runStatus: deriveRunStatus(view),
		busy: live?.run !== undefined,
		...(runTaskId === undefined ? {} : { activeRunTaskId: String(runTaskId) }),
		runningTools: runningToolNames(view),
		sandboxedUiEnabled: options.sandboxedUiEnabled,
		hooks: options.hooks,
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
	};
}
