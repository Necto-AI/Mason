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

/* ---- the listening meter ----
   While recording, the button's square becomes a row of capsule bars driven by the captured level — the
   signal that the mic is not just open but hearing something. The maths lives here, DOM-free. */

/** How many bars the meter shows: one per captured block, oldest scrolling out on the left. */
export const BAR_COUNT = 5;
/** A bar's height in the 16-unit icon box: quiet blocks rest at `BAR_MIN`, loud ones peg at `BAR_MAX`. */
export const BAR_MIN = 3;
export const BAR_MAX = 14;
/** RMS below this is the noise floor (a bar bottoms out); above this the bar pegs. */
export const LEVEL_FLOOR = 0.005;
export const LEVEL_CEIL = 0.25;

/** One captured block's RMS, 0..1+, to a bar height: clamped to the rails, then a square-root gamma so
    conversational levels (well under the ceiling) still read as motion. */
function barHeight(level: number): number {
	const t = Math.min(1, Math.max(0, (level - LEVEL_FLOOR) / (LEVEL_CEIL - LEVEL_FLOOR)));
	return BAR_MIN + Math.sqrt(t) * (BAR_MAX - BAR_MIN);
}

/** The rolling level history as the bars to draw: the newest `count` blocks, oldest first, left-padded
    with resting bars while the history is still building. */
export function barHeights(levels: readonly number[], count: number): number[] {
	const recent = levels.slice(-count);
	const resting = Array.from({ length: count - recent.length }, () => BAR_MIN);
	return [...resting, ...recent.map(barHeight)];
}
