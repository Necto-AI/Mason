/**
 * Proactive event hooks: timers, webhooks, and manual triggers that make the agent speak first.
 * A hook submits an input whose entry kind is `app.hook`, so clients can tell a proactive trigger
 * from a human message, and the durable run that answers it starts immediately.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Submission } from "@earendil-works/pi-durable";
import type { HookSummary } from "../shared/contract.ts";
import { entryFor, whenBusyFor } from "./admission.ts";

export interface EventHookConfig {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	/** When set, the hook fires periodically while enabled. */
	intervalMs?: number;
	promptTemplate: string;
	lastFiredAt?: string;
	fireCount: number;
}

/** What is persisted between restarts; the rest of a hook's definition is code. */
type PersistedHookState = Record<string, { enabled?: boolean; lastFiredAt?: string; fireCount?: number }>;

export interface HooksManagerOptions {
	/** Resolves the root conversation a hook submits to. */
	conversation(): Promise<Conversation>;
	/** Where `enabled` / `lastFiredAt` / `fireCount` survive a restart. */
	statePath?: string;
	now?(): Date;
	onReport?(error: unknown): void;
}

export interface FireOptions {
	readonly payload?: string;
	/**
	 * Idempotency key. A second fire with the same key returns the submission already made instead of starting a
	 * second turn. Callers with an event identity (a webhook delivery id, a schedule slot) pass one; a gesture that
	 * the user made — pressing Retry — passes nothing and gets a fresh key.
	 */
	readonly requestId?: string;
}

/** The scheduler's key: one fire per interval slot, so a re-arm cannot double-fire.
 *
 * `setInterval` fires late by a variable amount, so a slot boundary can straddle two timers. Slice 7
 * (`mason.schedule`) replaces this with a checkpointed `nextFireAt`; until then the slot is the best identity there
 * is.
 */
export function scheduledRequestId(hook: Pick<EventHookConfig, "id" | "intervalMs">, nowMs: number): string {
	const slotMs = Math.max(hook.intervalMs ?? 60_000, 1_000);
	return `hook:${hook.id}:slot:${Math.floor(nowMs / slotMs)}`;
}

export class UnknownHookError extends Error {
	constructor(id: string) {
		super(`Unknown event hook ${id}`);
		this.name = "UnknownHookError";
	}
}

export class HooksManager {
	readonly #hooks = new Map<string, EventHookConfig>();
	readonly #timers = new Map<string, NodeJS.Timeout>();
	readonly #options: HooksManagerOptions;	readonly #now: () => Date;
	readonly #persisted: PersistedHookState;
	/** Distinguishes two fires of the same hook made in the same millisecond. */
	#fireSeq = 0;
	#closed = false;

	constructor(options: HooksManagerOptions) {
		this.#options = options;
		this.#now = options.now ?? (() => new Date());
		this.#persisted = this.#readState();
	}

	/** Registers (or replaces) a hook definition; persisted runtime state is kept. */
	define(config: Omit<EventHookConfig, "fireCount"> & { fireCount?: number }): EventHookConfig {
		const previous = this.#hooks.get(config.id);
		const state = this.#persisted[config.id];
		const hook: EventHookConfig = {
			...config,
			enabled: state?.enabled ?? config.enabled,
			fireCount: config.fireCount ?? state?.fireCount ?? previous?.fireCount ?? 0,
			...(config.lastFiredAt ?? state?.lastFiredAt ?? previous?.lastFiredAt) === undefined
				? {}
				: { lastFiredAt: config.lastFiredAt ?? state?.lastFiredAt ?? previous?.lastFiredAt },
		};
		this.#hooks.set(hook.id, hook);
		if (hook.enabled) this.#arm(hook.id);
		return hook;
	}

	get(id: string): EventHookConfig | undefined {
		return this.#hooks.get(id);
	}

	list(): HookSummary[] {
		return [...this.#hooks.values()].map((hook) => ({
			id: hook.id,
			name: hook.name,
			description: hook.description,
			enabled: hook.enabled,
			fireCount: hook.fireCount,
			...(hook.intervalMs === undefined ? {} : { intervalMs: hook.intervalMs }),
			...(hook.lastFiredAt === undefined ? {} : { lastFiredAt: hook.lastFiredAt }),
		}));
	}

	/** Starts the interval timers of every enabled hook; safe to call once at startup. */
	start(): void {
		for (const id of this.#hooks.keys()) this.#arm(id);
	}

	setEnabled(id: string, enabled: boolean): EventHookConfig {
		const hook = this.#require(id);
		hook.enabled = enabled;
		if (enabled) this.#arm(id);
		else this.#disarm(id);
		this.#writeState();
		return hook;
	}

	has(id: string): boolean {
		return this.#hooks.has(id);
	}

	/**
	 * Fires a hook now: the promise settles once the submission is durably admitted, not when the answer arrives.
	 */
	async fire(id: string, options: FireOptions = {}): Promise<Submission> {
		if (this.#closed) throw new Error("Hooks manager is closed");
		const hook = this.#require(id);
		const payload = options.payload;
		const firedAt = this.#now().toISOString();
		const conversation = await this.#options.conversation();
		const submission = await conversation.submit(
			{
				type: "input",
				content: `[EVENT HOOK: ${hook.name}]\n${formatPrompt(hook, payload, firedAt)}`,
				entry: entryFor("hook", {
					hookId: hook.id,
					hookName: hook.name,
					payload: payload ?? null,
					firedAt,
				}),
				whenBusy: whenBusyFor("hook"),
				requestId: options.requestId ?? `hook:${hook.id}:fire:${firedAt}:${++this.#fireSeq}`,
			},
			BACKGROUND_CONTEXT,
		);
		hook.fireCount += 1;
		hook.lastFiredAt = firedAt;
		this.#writeState();
		return submission;
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const id of [...this.#timers.keys()]) this.#disarm(id);
	}

	#require(id: string): EventHookConfig {
		const hook = this.#hooks.get(id);
		if (hook === undefined) throw new UnknownHookError(id);
		return hook;
	}

	#arm(id: string): void {
		const hook = this.#hooks.get(id);
		// `enabled` is the single gate: a disabled hook is never armed, whatever calls this — a fresh
		// `define()`, `setEnabled()`, or `start()` walking every hook at startup.
		if (hook === undefined || !hook.enabled || hook.intervalMs === undefined || this.#closed) return;
		if (this.#timers.has(id)) return;
		const timer = setInterval(() => {
			this.fire(id, { requestId: scheduledRequestId(hook, this.#now().getTime()) }).catch((error: unknown) =>
				this.#report(error),
			);
		}, Math.max(hook.intervalMs, 1_000));
		// A pending timer never keeps the process alive; a durable agent is stopped explicitly.
		timer.unref();
		this.#timers.set(id, timer);
	}

	#disarm(id: string): void {
		const timer = this.#timers.get(id);
		if (timer === undefined) return;
		clearInterval(timer);
		this.#timers.delete(id);
	}

	#report(error: unknown): void {
		const report = this.#options.onReport;
		if (report !== undefined) report(error);
		else console.error(error);
	}

	#readState(): PersistedHookState {
		const path = this.#options.statePath;
		if (path === undefined) return {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			return typeof parsed === "object" && parsed !== null ? (parsed as PersistedHookState) : {};
		} catch {
			return {};
		}
	}

	#writeState(): void {
		const path = this.#options.statePath;
		if (path === undefined) return;
		const state: PersistedHookState = {};
		for (const hook of this.#hooks.values()) {
			state[hook.id] = {
				enabled: hook.enabled,
				fireCount: hook.fireCount,
				...(hook.lastFiredAt === undefined ? {} : { lastFiredAt: hook.lastFiredAt }),
			};
		}
		writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
	}
}

/** `{{payload}}`, `{{date}}`, `{{hook}}` are substituted; an unused payload is appended. */
export function formatPrompt(hook: EventHookConfig, payload: string | undefined, firedAt: string): string {
	let text = hook.promptTemplate
		.replaceAll("{{hook}}", hook.name)
		.replaceAll("{{date}}", firedAt)
		.replaceAll("{{payload}}", payload ?? "(none)");
	const mentionsPayload = hook.promptTemplate.includes("{{payload}}");
	if (payload !== undefined && !mentionsPayload) text = `${text}\n\nPayload:\n${payload}`;
	return text;
}

/** The hooks a fresh workspace starts with; `enabled: false` keeps them manual until asked for. */
export function builtinHooks(): Array<Omit<EventHookConfig, "fireCount">> {
	return [
		{
			id: "morning-brief",
			name: "Morning brief",
			description: "Check in at the start of the day: today's calendar, open threads, and what to do next.",
			enabled: false,
			intervalMs: 86_400_000,
			promptTemplate:
				"It is {{date}} and the day is starting. Check the workspace and the calendar for what today needs, then send a short brief: what is fixed, what is open, and the one thing to do first.",
		},
		{
			// Manual only: nothing schedules it, and the client's Retry control is the one caller.
			id: "retry-failed-run",
			name: "Retry a failed run",
			description:
				"Resume a run that ended in a model error. Fired by the Retry control on the failed turn, with the error as payload.",
			enabled: false,
			promptTemplate:
				"Your previous attempt failed before it finished, so the task is still open. Resume it from where it stopped: keep what is already done, redo only the step that failed, and do not start over from scratch. The failure was:\n{{payload}}",
		},
		{
			id: "workspace-check",
			name: "Workspace check",
			description: "Inspect the workspace (git status, uncommitted work, stale tasks) and report anything that needs attention.",
			enabled: false,
			promptTemplate:
				"Run a proactive workspace check. Look at git status and recent changes in the working directory, then report only what needs attention: uncommitted work, conflicts, or a broken build. If everything is clean, reply in one line.",
		},
	];
}
