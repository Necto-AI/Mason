/**
 * The run supervisor: an always-on agent must not be left dead by a provider outage.
 *
 * pi-ai already retries a failing model call inside a run (a few attempts with exponential backoff), so the run only
 * fails once that short budget is spent — a "terminated" / "Connection error." transcript is exactly that. What is
 * missing is re-arming *after* the run has ended: the durable layer settles the input as unanswered (`model_error`)
 * and waits for new work, so nothing resumes it and the turn stays dead.
 *
 * This supervisor watches the committed view, and when a run ends in a model error it fires the built-in
 * `retry-failed-run` hook on a slower schedule (seconds → minutes) — as a hook event, not a message the user never
 * wrote. Each attempt is visible in the transcript, the budget is small and it resets on success or on anything the
 * user submits, and the `retry-failed-run` hook (fired from the panel's Hooks page) stays the manual way out.
 */
import type { ConversationView } from "@earendil-works/pi-durable";
import { isBusy } from "./status.ts";

/** The hook the supervisor fires (`builtinHooks()` in `hooks.ts`); the panel's Hooks page fires the same one. */
export const RETRY_HOOK_ID = "retry-failed-run";

/** Delays between automatic re-fires, per attempt. Longer than a provider blip, shorter than a lost afternoon. */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 300_000, 900_000];

export interface RunRetryOptions {
	/** Automatic re-fires allowed before the supervisor gives up and leaves the manual retry hook to it. */
	readonly maxAttempts?: number;
	/** Delay before each attempt, in order; the last value repeats. */
	readonly delaysMs?: readonly number[];
}

export type RunRetryPlan =
	/** The run is over and failed: fire the retry hook after `delayMs`. */
	| { readonly kind: "wait"; readonly delayMs: number; readonly attempt: number; readonly error: string }
	/** Nothing to do: no failure yet, one already handled, still running, or the budget is spent. */
	| { readonly kind: "idle"; readonly reason: "clean" | "handled" | "busy" | "budget" };

export interface RunRetryInput {
	readonly busy: boolean;
	/** Id of the newest assistant answer that ended in a model error, if any. */
	readonly errorId: string | undefined;
	/** Its message, for the retry payload. */
	readonly errorMessage: string | undefined;
	/** The error the supervisor last acted on (`undefined` before the first). */
	readonly handledErrorId: string | undefined;
	/** Automatic re-fires fired since the last success or user input. */
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly delaysMs: readonly number[];
}

/**
 * Decide what to do about a failed run. Pure: the caller owns the attempt counter, the timer and the clock, so this
 * is the whole policy in one testable place.
 */
export function planRunRetry(input: RunRetryInput): RunRetryPlan {
	if (input.busy) return { kind: "idle", reason: "busy" };
	if (input.errorId === undefined) return { kind: "idle", reason: "clean" };
	// The same failure cannot be retried twice: a re-fire appends a fresh error entry with a new id.
	if (input.errorId === input.handledErrorId) return { kind: "idle", reason: "handled" };
	if (input.attempts >= input.maxAttempts) return { kind: "idle", reason: "budget" };
	const delayMs = input.delaysMs[Math.min(input.attempts, input.delaysMs.length - 1)] ?? 0;
	return {
		kind: "wait",
		delayMs,
		attempt: input.attempts + 1,
		error: input.errorMessage === undefined || input.errorMessage === "" ? "no error message" : input.errorMessage,
	};
}

/** The newest entry that ended in a model error, and the newest answer that did not. Pure: reads the view only. */
export function readRunOutcome(view: ConversationView | undefined): {
	errorId: string | undefined;
	errorMessage: string | undefined;
	/** Does the transcript hold an answer newer than that error? Then the failure was already made good. */
	answeredAfterError: boolean;
} {
	const entries = view?.entries ?? [];
	let errorIndex = -1;
	let errorId: string | undefined;
	let errorMessage: string | undefined;
	entries.forEach((entry, index) => {
		if (entry.kind !== "pi.assistant") return;
		const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
		if (message?.stopReason !== "error") return;
		errorIndex = index;
		errorId = String(entry.id);
		errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
	});
	if (errorId === undefined) return { errorId: undefined, errorMessage: undefined, answeredAfterError: false };
	const answeredAfterError = entries.slice(errorIndex + 1).some((entry) => entry.kind === "pi.assistant");
	return { errorId, errorMessage, answeredAfterError };
}

/**
 * Holds the supervisor's memory and its timer: `observe` on every committed view, `acted` when the user submits.
 * `fire` is called with the failure text once a plan matures.
 */
export class RunRetrySupervisor {
	readonly #fire: (error: string) => Promise<void> | void;
	readonly #options: Required<RunRetryOptions>;
	readonly #timer: {
		set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
		clear: (handle: ReturnType<typeof setTimeout>) => void;
	};
	#handledErrorId: string | undefined;
	#attempts = 0;
	#pending: ReturnType<typeof setTimeout> | undefined;
	/** Bumped whenever the pending re-fire is abandoned, so a timer already dispatched cannot fire. */
	#generation = 0;
	#closed = false;

	constructor(
		fire: (error: string) => Promise<void> | void,
		options: RunRetryOptions = {},
		timer: {
			set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
			clear: (handle: ReturnType<typeof setTimeout>) => void;
		} = { set: setTimeout, clear: clearTimeout },
	) {
		this.#fire = fire;
		this.#options = {
			maxAttempts: options.maxAttempts ?? DEFAULT_RETRY_DELAYS_MS.length,
			delaysMs: options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS,
		};
		this.#timer = timer;
	}

	/** The delays in force, for the log line that says what the agent will do about a failure. */
	get delaysMs(): readonly number[] {
		return this.#options.delaysMs;
	}

	/** Called with the committed view after every sync. */
	observe(view: ConversationView | undefined): void {
		if (this.#closed) return;
		const outcome = readRunOutcome(view);
		// A good answer, or a fresh user input, clears the budget: the next failure starts over.
		if (outcome.errorId === undefined || outcome.answeredAfterError) {
			this.#attempts = 0;
			this.#handledErrorId = outcome.errorId;
		}
		const plan = planRunRetry({
			busy: isBusy(view),
			errorId: outcome.errorId,
			errorMessage: outcome.errorMessage,
			handledErrorId: this.#handledErrorId,
			attempts: this.#attempts,
			maxAttempts: this.#options.maxAttempts,
			delaysMs: this.#options.delaysMs,
		});
		if (plan.kind !== "wait") return;
		if (this.#pending !== undefined) return;
		this.#handledErrorId = outcome.errorId;
		this.#attempts = plan.attempt;
		console.warn(
			`[run-retry] run failed (${plan.error}); retry ${plan.attempt}/${this.#options.maxAttempts} in ${Math.round(plan.delayMs / 1000)}s`,
		);
		const generation = ++this.#generation;
		this.#pending = this.#timer.set(() => {
			this.#pending = undefined;
			if (this.#closed || generation !== this.#generation) return;
			void Promise.resolve(this.#fire(plan.error)).catch((error: unknown) => {
				console.error("[run-retry] could not fire the retry hook:", error);
			});
		}, plan.delayMs);
	}

	/** The user did something: drop the pending re-fire and let their input lead. */
	acted(): void {
		this.#attempts = 0;
		this.#generation += 1;
		if (this.#pending !== undefined) {
			this.#timer.clear(this.#pending);
			this.#pending = undefined;
		}
	}

	close(): void {
		this.#closed = true;
		this.acted();
	}
}
