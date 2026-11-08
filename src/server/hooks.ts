/**
 * What wakes the bot without a person's input: a routine, an event, and the controls that make the agent speak first.
 *
 * A routine is a timer the agent owns, configured in `agent/routines.json` — the agent edits the file with `write`, and
 * a deployment ships none. An event is a connector fire the operator granted, of a kind its grant names; the kind map
 * points at a hook id, so the id a grant names must exist in the file (or be defined in code, the way the run
 * supervisor's retry lifecycle hook is). Runtime state (`lastFiredAt`, `fireCount`, `nextFireAt`) stays in `service/data/`, so
 * the agent's git diff shows only what it chose.
 *
 * A fire submits an input whose entry kind is `app.hook`, so clients can tell a proactive trigger from a human message,
 * and the durable run that answers it starts immediately.
 */
import { randomUUID } from "node:crypto";
import { type FSWatcher, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Submission } from "@earendil-works/pi-durable";
import type { Origin } from "mason-protocol";
import type { HookSummary } from "../shared/contract.ts";
import { entryFor, whenBusyFor } from "./admission.ts";
import { fenceUntrusted } from "./untrusted.ts";

export interface EventHookConfig {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	/**
	 * When set, the definition fires on a schedule, one fire per interval slot (`scheduledRequestId()`): a one-minute
	 * interval has a slot that long, and re-arming cannot double-fire inside it.
	 */
	intervalMs?: number;
	/**
	 * What an event does to a turn already running: `steer` interrupts it, `followUp` queues behind it. It is the
	 * routine's own choice, read from `agent/routines.json`, because it decides how a particular wake treats a
	 * particular turn — a page that must be seen now, a log summary that can wait.
	 */
	whenBusy?: "steer" | "followUp";
	promptTemplate: string;
	lastFiredAt?: string;
	fireCount: number;
}

/**
 * One routine as `agent/routines.json` carries it: a name, the prompt a wake sends, and how it behaves.
 *
 * `intervalSeconds` is optional on purpose. A routine with one is a timer; a routine without one is only ever woken by
 * an event whose kind the operator's grant maps to it, and a timer nothing asked for is not a default worth making.
 */
export interface RoutineConfig {
	name: string;
	intervalSeconds?: number;
	prompt: string;
	/** `steer` or `followUp` against a running turn. Absent is `followUp`: a wake waits its turn unless it says otherwise. */
	whenBusy?: "steer" | "followUp";
	/** Absent is `true`. A switched-off routine keeps its grant mapping and stops waking the bot. */
	enabled?: boolean;
}

/** The id the run supervisor's retry lifecycle hook occupies (`RETRY_HOOK_ID` in `run-retry.ts`); the file cannot take it. */
export const RESERVED_ROUTINE_ID: ReadonlySet<string> = new Set(["retry-failed-run"]);

/**
 * Validate one routines file before a word of it arms anything. Names must be the ids a connector's kind map names,
 * so the file and an integration's grant cannot drift apart by an uppercase letter.
 */
export function parseRoutines(text: string): RoutineConfig[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error: unknown) {
		throw new Error(`is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!Array.isArray(parsed)) throw new Error("is not an array of routines");
	const seen = new Set<string>();
	return parsed.map((entry) => {
		if (typeof entry !== "object" || entry === null) throw new Error("has an entry that is not an object");
		const routine = entry as Record<string, unknown>;
		if (typeof routine.name !== "string" || /^[a-z0-9-]+$/.test(routine.name) === false) {
			throw new Error(`has a name that is not [a-z0-9-]: ${JSON.stringify(routine.name)}`);
		}
		if (seen.has(routine.name)) throw new Error(`names "${routine.name}" twice`);
		if (RESERVED_ROUTINE_ID.has(routine.name)) {
			throw new Error(`"${routine.name}" is kept for the run supervisor's retry lifecycle hook`);
		}
		seen.add(routine.name);
		// A routine without an interval is woken by an event and only by an event: no timer, and nothing to validate.
		if (
			routine.intervalSeconds !== undefined &&
			(typeof routine.intervalSeconds !== "number" ||
				!Number.isInteger(routine.intervalSeconds) ||
				routine.intervalSeconds < 30)
		) {
			throw new Error(`"${routine.name}" has an intervalSeconds that is not an integer of at least 30`);
		}
		if (typeof routine.prompt !== "string" || routine.prompt === "") {
			throw new Error(`"${routine.name}" has an empty prompt`);
		}
		const whenBusy = routine.whenBusy;
		if (whenBusy !== undefined && whenBusy !== "steer" && whenBusy !== "followUp") {
			throw new Error(`"${routine.name}" has a whenBusy that is not "steer" or "followUp"`);
		}
		if (routine.enabled !== undefined && typeof routine.enabled !== "boolean") {
			throw new Error(`"${routine.name}" has an "enabled" that is not true or false`);
		}
		return {
			name: routine.name,
			...(routine.intervalSeconds === undefined ? {} : { intervalSeconds: routine.intervalSeconds }),
			prompt: routine.prompt,
			...(whenBusy === undefined ? {} : { whenBusy }),
			...(routine.enabled === undefined ? {} : { enabled: routine.enabled }),
		};
	});
}

/**
 * Apply one file's routines. An absent file is the shipped default: a deployment starts with none. Any other read
 * problem (bad JSON, a validation failure, an unreadable file) comes back as `problem` with the caller's path absent
 * from it, and the manager keeps the last good set armed and reports it once.
 */
function readRoutinesFile(path: string): { routines: RoutineConfig[]; problem: Error | undefined } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error: unknown) {
		if ((error as { code?: string }).code === "ENOENT") return { routines: [], problem: undefined };
		return { routines: [], problem: new Error(`cannot be read (${error instanceof Error ? error.message : error})`) };
	}
	try {
		return { routines: parseRoutines(text), problem: undefined };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { routines: [], problem: new Error(`is malformed: ${message}`) };
	}
}

/** What is persisted between restarts, in `service/data/`; the rest of a hook's definition lives in the file or code. */
type PersistedHookState = Record<
	string,
	{ enabled?: boolean; lastFiredAt?: string; fireCount?: number; nextFireAt?: string }
>;

/**
 * How a caller identifies a fire. `payload` is what the prompt template receives; `requestId` is the fire's durable
 * identity — pi-durable admits one submission per key, so a second fire with the same key does not start a turn.
 *
 * The key belongs to the caller, because only the caller knows what "the same event" means:
 * - a sender that names its delivery, through `explicitRequestId()`: exact, and permanent;
 * - a schedule, through `scheduledRequestId()`: one fire per interval slot, so re-arming cannot double-fire;
 * - a gesture — the run supervisor, or a caller naming no delivery — passes none: an act is an intent, so two
 *   clicks are two fires, and `fire()` gives each one via `gestureRequestId()`.
 *
 * A fire that names its delivery collapses on the first tier, however late it repeats; a gesture is never collapsed,
 * because two presses are two intents. There is no body-identified tier: a sender that cannot name what it sent has no
 * way in.
 */
export interface FireOptions {
	readonly payload?: string;
	readonly requestId?: string;
	/**
	 * What happened, as the sender named it (`issue.opened`, `push`): a label for the log and the prompt, never a dispatch
	 * key — one trigger fires one definition, and nothing here decides anything from it. When it is present the wake is an
	 * event and the marker says so; its absence is the routine's own timer, and the marker says that instead.
	 */
	readonly kind?: string;
	/**
	 * Where the event came from, when the sender could name an address. It is what a send targets: an event that carries
	 * an origin is one whose answer has a reader, and one that does not is recorded with nobody reached.
	 */
	readonly origin?: Origin;
}

/**
 * What every fired hook's input opens with, so the turn it starts is recognisable from the text alone.
 *
 * The model sees it — a proactive turn has to read as one — and so does every reader that has only the conversation's
 * messages to go on: the delivery gate, and `reply` itself, which tells a hooked turn with no origin from a person's.
 */
export function routineMarker(name: string): string {
	return `[ROUTINE: ${name}]`;
}

/** The first line of an event's wake: the kind the sender named, never the routine's own timer. */
export function eventMarker(kind: string): string {
	return `[EVENT: ${kind}]`;
}

export interface HooksManagerOptions {
	/** Resolves the root conversation a hook submits to. */
	conversation(): Promise<Conversation>;
	/**
	 * Where `enabled` / `lastFiredAt` / `fireCount` / `nextFireAt` survive a restart
	 * (`service/data/routines-state.json`). Absent in tests that keep everything in memory.
	 */
	statePath?: string;
	/** The file the agent owns: `agent/routines.json`. Read at boot, re-read when it changes. */
	routinesPath?: string;
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
	/** Ids that came from the agent's routines file; a re-read may remove only these. */
	readonly #routines = new Set<string>();
	readonly #timers = new Map<string, NodeJS.Timeout>();
	readonly #options: HooksManagerOptions;
	readonly #now: () => Date;
	#state: PersistedHookState;
	#closed = false;
	#watcher: FSWatcher | undefined;
	#watchDebounce: NodeJS.Timeout | undefined;
	#reportedProblem: string | undefined;

	constructor(options: HooksManagerOptions) {
		this.#options = options;
		this.#now = options.now ?? (() => new Date());
		this.#state = this.#readState();
		this.#loadRoutines();
	}

	/**
	 * Read `agent/routines.json` once: the routines it holds become armed hooks, a malformed file reports one notice and
	 * leaves whatever is armed armed, and an absent file means none. Boot must know the routines before the connector
	 * grants are checked, because a grant names a hook id that has to exist.
	 */
	#loadRoutines(): void {
		const path = this.#options.routinesPath;
		if (path === undefined) return;
		const read = readRoutinesFile(path);
		if (read.problem !== undefined) {
			this.#reportProblem(new Error(`${path} ${read.problem.message}`));
			return;
		}
		this.setRoutines(read.routines);
	}

	/**
	 * Replace the file's routines with this set: removed names are disarmed, new ones fire after their interval, and a
	 * changed interval or prompt resets the timer — its persisted slot belonged to the routine it fired. Anything the
	 * re-read did not touch keeps its arm and its persisted `nextFireAt`.
	 */
	setRoutines(routines: readonly RoutineConfig[]): void {
		const next = new Map(routines.map((routine) => [routine.name, routine]));
		for (const id of this.#routines) {
			if (next.has(id)) continue;
			this.#routines.delete(id);
			this.#disarm(id);
			this.#hooks.delete(id);
		}
		for (const routine of routines) {
			const intervalMs = routine.intervalSeconds === undefined ? undefined : routine.intervalSeconds * 1_000;
			const current = this.#hooks.get(routine.name);
			// A definition this manager already held is the only one a re-read can reset: on the first load the persisted
			// slot came from the previous process's schedule, and there is nothing to compare it against — the boot scan
			// inherits it as the schedule was written.
			const changed =
				current !== undefined && (current.intervalMs !== intervalMs || current.promptTemplate !== routine.prompt);
			let state = this.#state[routine.name];
			if (state === undefined) {
				state = {};
				this.#state[routine.name] = state;
			}
			if (changed) delete state.nextFireAt;
			this.#hooks.set(routine.name, {
				id: routine.name,
				name: routine.name,
				description: "",
				// `enabled` and `whenBusy` are the file's, not the persisted state's: the agent edits one file and every
				// part of a routine's behaviour is in it.
				enabled: routine.enabled ?? true,
				...(intervalMs === undefined ? {} : { intervalMs }),
				...(routine.whenBusy === undefined ? {} : { whenBusy: routine.whenBusy }),
				promptTemplate: routine.prompt,
				...(state.lastFiredAt === undefined ? {} : { lastFiredAt: state.lastFiredAt }),
				fireCount: state.fireCount ?? current?.fireCount ?? 0,
			});
			this.#routines.add(routine.name);
		}
		for (const routine of routines) this.#arm(routine.name);
		this.#writeState();
	}

	/** Registers (or replaces) a lifecycle hook definition from code; persisted runtime state is kept. */
	define(config: Omit<EventHookConfig, "fireCount"> & { fireCount?: number }): EventHookConfig {
		const previous = this.#hooks.get(config.id);
		const state = this.#state[config.id];
		// `enabled` is never taken from the file: the routines file names only routines, and a hook defined where it
		// fires describes itself.
		const existing = this.#routines.has(config.id);
		if (existing) throw new Error(`"${config.id}" is a routine the agent owns: code does not define it again`);
		const hook: EventHookConfig = {
			...config,
			enabled: state?.enabled ?? config.enabled,
			fireCount: config.fireCount ?? state?.fireCount ?? previous?.fireCount ?? 0,
			...((config.lastFiredAt ?? state?.lastFiredAt ?? previous?.lastFiredAt) === undefined
				? {}
				: { lastFiredAt: config.lastFiredAt ?? state?.lastFiredAt ?? previous?.lastFiredAt }),
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

	/** Arms every hook it knows and starts watching the routines file; safe to call once at startup. */
	start(): void {
		for (const id of this.#routines) this.#arm(id);
		this.#watchRoutinesFile();
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
		const kind = options.kind;
		const origin = options.origin;
		const firedAt = this.#now().toISOString();
		const conversation = await this.#options.conversation();
		const submission = await conversation.submit(
			{
				type: "input",
				content: `${kind === undefined ? routineMarker(hook.name) : eventMarker(kind)}\n${formatPrompt(hook, payload, firedAt)}`,
				entry: entryFor("hook", {
					hookId: hook.id,
					hookName: hook.name,
					payload: payload ?? null,
					firedAt,
					...(kind === undefined ? {} : { kind }),
					...(origin === undefined
						? {}
						: {
								origin: {
									connector: origin.connector,
									ref: origin.ref,
									...(origin.messageId === undefined ? {} : { messageId: origin.messageId }),
									...(origin.actor === undefined ? {} : { actor: origin.actor }),
								},
							}),
				}),
				whenBusy: hook.whenBusy ?? whenBusyFor("hook"),
				requestId: options.requestId ?? gestureRequestId(hook.id),
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
		this.#watcher?.close();
		this.#watcher = undefined;
		if (this.#watchDebounce !== undefined) clearTimeout(this.#watchDebounce);
		for (const id of [...this.#timers.keys()]) this.#disarm(id);
	}

	#require(id: string): EventHookConfig {
		const hook = this.#hooks.get(id);
		if (hook === undefined) throw new UnknownHookError(id);
		return hook;
	}

	#arm(id: string): void {
		const hook = this.#hooks.get(id);
		const intervalMs = hook?.intervalMs;
		// `enabled` is the single gate: a disabled hook is never armed, whatever calls this.
		if (hook === undefined || intervalMs === undefined || !hook.enabled || this.#closed) return;
		this.#disarm(id);
		let state = this.#state[id];
		if (state === undefined) {
			state = {};
			this.#state[id] = state;
		}
		// The boot scan: the schedule was written when the slot was, so a restart waits the remainder instead of arming a
		// fresh full interval, and a slot already past due fires once from its own slot key — never once per missed slot.
		if (state.nextFireAt === undefined) {
			state.nextFireAt = new Date(this.#now().getTime() + intervalMs).toISOString();
			this.#writeState();
		}
		const dueMs = Date.parse(state.nextFireAt);
		const waitMs = dueMs - this.#now().getTime();
		if (waitMs <= 0) {
			void this.#catchUp(hook, intervalMs, dueMs);
			return;
		}
		const timer = setTimeout(() => void this.#due(hook, intervalMs, dueMs), waitMs);
		// A pending timer never keeps the process alive; a durable agent is stopped explicitly.
		timer.unref();
		this.#timers.set(id, timer);
	}

	/** The slot is due now: one fire, then the next slot is written at once, so a timeout never stacks. */
	async #due(hook: EventHookConfig, intervalMs: number, dueMs: number): Promise<void> {
		// The slot is written before it is submitted: a fire that cannot be admitted was still scheduled, and the
		// rhythm survives the next restart instead of an error silencing the routine for good. The identity is the
		// slot that fired, not the moment the fire went out, so a slow hand of the clock cannot rename it.
		this.#advance(hook.id, intervalMs, dueMs);
		try {
			await this.fire(hook.id, { requestId: scheduledRequestId({ id: hook.id, intervalMs }, dueMs) });
		} catch (error: unknown) {
			this.#report(error);
		}
	}

	/** A slot the process did not keep: one catch-up fire from the missed slot's own key, then skip the rest. */
	async #catchUp(hook: EventHookConfig, intervalMs: number, dueMs: number): Promise<void> {
		// Skipped through before the submission, the same order `#due` keeps: a re-arm that walks in while the catch-up
		// awaits then finds the schedule resumed in the future, so the delayed fire is the only one the slot gets.
		this.#advance(hook.id, intervalMs, dueMs);
		try {
			// The slot the key names is the one `#advance` just wrote (`dueMs`), which a second catch-up of the same
			// delayed slot then deduplicates by: the advance precedes every fire, so `dueMs` is always fresh, while
			// `dueMs - 1` aliaes the previous slot's already-consumed key when the schedule sits on a slot boundary.
			await this.fire(hook.id, { requestId: scheduledRequestId({ id: hook.id, intervalMs }, dueMs) });
		} catch (error: unknown) {
			this.#report(error);
		}
	}

	/** Writes the next due slot and arms the timer for it: the rhythm is `dueMs + interval`, skipped past the present. */
	#advance(id: string, intervalMs: number, dueMs: number): void {
		if (this.#closed) return;
		const state = this.#state[id];
		if (state === undefined) return;
		// The slot that fired is spent; the next one is the first slot boundary strictly beyond the present. When the
		// present sits exactly on a boundary the downtime of a downtime cannot fire twice from it, so the arithmetic
		// counts it as spent and recovers beyond it — a restart's gap is skipped, never queued as a stampede.
		const elapsedSlots = Math.max(Math.floor((this.#now().getTime() - dueMs) / intervalMs), 0);
		const nextMs = dueMs + (elapsedSlots + 1) * intervalMs;
		state.nextFireAt = new Date(nextMs).toISOString();
		this.#writeState();
		this.#arm(id);
	}

	#disarm(id: string): void {
		const timer = this.#timers.get(id);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.#timers.delete(id);
	}

	#report(error: unknown): void {
		const report = this.#options.onReport;
		if (report !== undefined) report(error);
		else console.error(error);
	}

	/** One notice per distinct problem, no matter how many times the watcher's debounce re-reads a broken file. */
	#reportProblem(error: Error): void {
		if (this.#reportedProblem === error.message) return;
		this.#reportedProblem = error.message;
		this.#report(error);
	}

	/** Watch the directory the file lives in (an edit may replace it), and re-read it debounced. */
	#watchRoutinesFile(): void {
		if (this.#closed || this.#options.routinesPath === undefined || this.#watcher !== undefined) return;
		const directory = dirname(this.#options.routinesPath);
		try {
			this.#watcher = watch(directory, { persistent: false }, () => {
				if (this.#closed) return;
				// Any write to the agent's root may leave the file replaced; the re-read decides. Other writes (the
				// profile, the log) are an idempotent no-op this pass.
				if (this.#watchDebounce !== undefined) clearTimeout(this.#watchDebounce);
				this.#watchDebounce = setTimeout(() => {
					this.#watchDebounce = undefined;
					if (this.#closed) return;
					const read = readRoutinesFile(this.#options.routinesPath as string);
					if (read.problem !== undefined) {
						this.#reportProblem(new Error(`${this.#options.routinesPath} ${read.problem.message}`));
						return;
					}
					this.#reportedProblem = undefined;
					this.setRoutines(read.routines);
				}, 100);
			});
		} catch (error: unknown) {
			this.#report(
				new Error(`agent/routines.json cannot be watched (${error instanceof Error ? error.message : error})`),
			);
		}
	}

	#readState(): PersistedHookState {
		const path = this.#options.statePath;
		if (path === undefined) return {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as PersistedHookState)
				: {};
		} catch {
			return {};
		}
	}

	#writeState(): void {
		const path = this.#options.statePath;
		if (path === undefined) return;
		try {
			const state: PersistedHookState = {};
			for (const hook of this.#hooks.values()) {
				const persisted = this.#state[hook.id] ?? {};
				state[hook.id] = {
					// A routine's switch is `agent/routines.json`'s; only a hook defined in code has its state persisted.
					...(this.#routines.has(hook.id) ? {} : { enabled: hook.enabled }),
					fireCount: hook.fireCount,
					...(hook.lastFiredAt === undefined
						? persisted.lastFiredAt === undefined
							? {}
							: { lastFiredAt: persisted.lastFiredAt }
						: { lastFiredAt: hook.lastFiredAt }),
					...(persisted.nextFireAt === undefined ? {} : { nextFireAt: persisted.nextFireAt }),
				};
			}
			writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
			this.#state = state;
		} catch (error: unknown) {
			this.#report(error);
		}
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
 * A gesture: a click, a retry, a control the reader pressed, with no identity but its own intent. Two gestures must be
 * two fires, and the key must stay unique across a restart — a per-process counter is not, since the request ids
 * pi-durable holds are permanent — so every gesture draws a fresh random id.
 */
export function gestureRequestId(hookId: string, gestureId: string = randomUUID()): string {
	return `hook:${hookId}:gesture:${gestureId}`;
}

/**
 * The scheduler's identity: one fire per interval slot, so a re-arm cannot double-fire and a daily routine is
 * deduplicated into a single fire for good. `nextFireAt` holds the slot's start, so the boot scan inherits its identity
 * from the same key a live timer would have used.
 */
export function scheduledRequestId(hook: { readonly id: string; readonly intervalMs: number }, nowMs: number): string {
	const slotMs = Math.max(hook.intervalMs, 1_000);
	return `hook:${hook.id}:slot:${Math.floor(nowMs / slotMs)}`;
}

/**
 * `{{payload}}`, `{{date}}`, `{{hook}}` are substituted; an unused payload is appended, fenced as untrusted data.
 *
 * The wake's marker (routine or event) is the input's first line and is written by the fire path, not by this
 * function: a template never decides whether it is shown, and a prompt that mentioned a kind the sender did not send
 * would be a lie about the event.
 */
export function formatPrompt(hook: EventHookConfig, payload: string | undefined, firedAt: string): string {
	const fenced = payload === undefined ? undefined : fenceUntrusted(payload);
	let text = hook.promptTemplate
		.replaceAll("{{hook}}", hook.name)
		.replaceAll("{{date}}", firedAt)
		.replaceAll("{{payload}}", fenced ?? "(none)");
	// The payload arrives under its label when the template has no placeholder, so what quotes it is always visible.
	if (hook.promptTemplate.includes("{{payload}}") === false && fenced !== undefined) {
		text = `${text}\n\nPayload:\n${fenced}`;
	}
	return text;
}
