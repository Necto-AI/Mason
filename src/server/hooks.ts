/**
 * Proactive event hooks: timers, webhooks, and manual triggers that make the agent speak first.
 * A hook submits an input whose entry kind is `app.hook`, so clients can tell a proactive trigger
 * from a human message, and the durable run that answers it starts immediately.
 */
import { createHash } from "node:crypto";
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
	/**
	 * When set, the hook fires periodically while enabled. Authoring rule: an interval shorter than
	 * `BODY_DEDUPE_WINDOW_MS` is only safe for senders that pass their own id — a body-identified fire is deduplicated
	 * per `BODY_DEDUPE_WINDOW_MS`, so a hook that fires more often than that from a dumb sender loses fires. `define()`
	 * warns about it.
	 */
	intervalMs?: number;
	promptTemplate: string;
	lastFiredAt?: string;
	fireCount: number;
}

/** What is persisted between restarts; the rest of a hook's definition is code. */
type PersistedHookState = Record<string, { enabled?: boolean; lastFiredAt?: string; fireCount?: number }>;

/**
 * How a caller identifies a fire. `payload` is what the prompt template receives; `requestId` is the fire's durable
 * identity — pi-durable admits one submission per key, so a second fire with the same key does not start a turn.
 *
 * The key belongs to the caller, because only the caller knows what "the same event" means:
 * - a sender that names its delivery, through `explicitRequestId()`: exact, and permanent;
 * - a sender that cannot, through `bodyRequestId()`: one event per `BODY_DEDUPE_WINDOW_MS`, so a redelivery inside the
 *   window collapses and tomorrow's identical digest still fires;
 * - a schedule, through `scheduledRequestId()`: one fire per interval slot, so re-arming cannot double-fire;
 * - a gesture — the Retry control, the run supervisor, a chord `fireHook` — passes none: a click is an intent, so two
 *   clicks are two fires, and `fire()` gives each its own key.
 */
export interface FireOptions {
	readonly payload?: string;
	readonly requestId?: string;
}

/** The window a body-identified fire is deduplicated in: replays inside it collapse, the next window fires again. */
export const BODY_DEDUPE_WINDOW_MS = 60_000;

export interface HooksManagerOptions {
	/** Resolves the root conversation a hook submits to. */
	conversation(): Promise<Conversation>;
	/** Where `enabled` / `lastFiredAt` / `fireCount` survive a restart. */
	statePath?: string;
	now?(): Date;
	onReport?(error: unknown): void;
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
	/** Distinguishes two gesture fires of the same hook made in the same millisecond. */
	#fireSeq = 0;
	#closed = false;

	constructor(options: HooksManagerOptions) {
		this.#options = options;
		this.#now = options.now ?? (() => new Date());
		this.#persisted = this.#readState();
	}

	/**
	 * Registers (or replaces) a hook definition; persisted runtime state is kept.
	 *
	 * Authoring rule, enforced here as a warning: a hook must not fire more often than `BODY_DEDUPE_WINDOW_MS` unless
	 * its senders pass their own id (`explicitRequestId()`). Below that interval a body-identified fire lands in the
	 * same dedupe window twice and the second fire is collapsed; at or above it, the window is enough.
	 */
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
		if (hook.intervalMs !== undefined && hook.intervalMs < BODY_DEDUPE_WINDOW_MS) {
			console.warn(
				`[hooks] ${hook.id} fires every ${hook.intervalMs}ms, inside the ${BODY_DEDUPE_WINDOW_MS}ms body-dedupe window: only senders that pass an explicit request id are safe at this rate`,
			);
		}
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
	 * `options.requestId` is the fire's identity (see `FireOptions`); without one this is a gesture and every call is
	 * a fire of its own. A fire that a known key collapses still counts in `fireCount`: the hook was asked to fire.
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
				entry: entryFor("hook", { hookId: hook.id, hookName: hook.name, payload: payload ?? null, firedAt }),
				whenBusy: whenBusyFor("hook"),
				requestId: options.requestId ?? `hook:${hook.id}:gesture:${firedAt}:${++this.#fireSeq}`,
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
			const requestId = scheduledRequestId(hook, this.#now().getTime());
			this.fire(id, { requestId }).catch((error: unknown) => this.#report(error));
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

/**
 * A sender that names its delivery: the same id is the same event, however much later it arrives. Namespaced by hook,
 * so one sender's counter cannot collide with another hook's.
 */
export function explicitRequestId(hookId: string, senderId: string): string {
	return `hook:${hookId}:request:${senderId}`;
}

/**
 * A sender that cannot name its delivery: the same body is the same event inside one `BODY_DEDUPE_WINDOW_MS` window.
 * Bucketed by time rather than hashed forever, because pi-durable never forgets a request id — a byte-identical daily
 * digest would otherwise fire once, ever.
 */
export function bodyRequestId(hookId: string, body: unknown, nowMs: number): string {
	const hash = createHash("sha256").update(canonicalJson(body)).digest("hex").slice(0, 16);
	return `hook:${hookId}:body:${hash}:${Math.floor(nowMs / BODY_DEDUPE_WINDOW_MS)}`;
}

/**
 * The scheduler's identity: one fire per interval slot, so a re-arm cannot double-fire and a daily hook is not
 * deduplicated into a single fire for good. `setInterval` fires late by a variable amount, so a slot boundary can
 * straddle two timers; the slot is still the best identity there is until scheduling is checkpointed.
 */
export function scheduledRequestId(hook: Pick<EventHookConfig, "id" | "intervalMs">, nowMs: number): string {
	const slotMs = Math.max(hook.intervalMs ?? BODY_DEDUPE_WINDOW_MS, 1_000);
	return `hook:${hook.id}:slot:${Math.floor(nowMs / slotMs)}`;
}

/** JSON with object keys in a fixed order at every depth; arrays keep their order and their length. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const fields = Object.entries(value as Record<string, unknown>)
			.filter(([, field]) => field !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${fields.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
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
