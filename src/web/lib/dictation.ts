/**
 * The dictation interaction as decisions rather than DOM: what a press means, what a release means, and when a
 * recording is worth sending.
 *
 * One button serves two habits. A quick click latches the recording — it keeps running until the next click, the
 * way ChatGPT's mic behaves — while holding the button is push-to-talk: release ends the recording and sends it.
 * The split is a threshold on the press, and the button itself says what it will do next (`DictationButton`
 * writes it into the title), so neither habit needs to know the rule.
 */

export type DictationPhase = "idle" | "recording" | "transcribing";

/** A press at least this long is push-to-talk; a shorter one latches the recording until the next click. */
export const HOLD_MS = 400;
/** A recording shorter than this is a slip, not an utterance: dropped without a request. */
export const MIN_MS = 300;

/** What pressing the button means right now. */
export function pressOutcome(phase: DictationPhase, latched: boolean): "start" | "stop" | "ignore" {
	if (phase === "transcribing") return "ignore";
	// A hold in flight is not a new press: only its release decides what happens, or a slow second finger would.
	if (phase === "recording") return latched ? "stop" : "ignore";
	return "start";
}

/** What releasing the button means: push-to-talk is over, or the recording latches until the next click. */
export function releaseOutcome(pressedMs: number): "talk" | "latch" {
	return pressedMs >= HOLD_MS ? "talk" : "latch";
}

/** Whether a finished recording deserves a round trip. */
export function worthTranscribing(recordedMs: number): boolean {
	return recordedMs >= MIN_MS;
}
