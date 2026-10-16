/**
 * Height policy for a streaming widget.
 *
 * The widget's own layout is the only honest source of its height, but while the call streams that layout is
 * still being written: it reports a cropped box one moment and an over-tall one the next. So the frame never
 * follows a report blindly — it grows and holds, and only the settled document may shrink it.
 */

/** Height of the placeholder box the model estimates, kept in a range that reads as a card rather than a pane. */
export const PLACEHOLDER_MIN = 96;
export const PLACEHOLDER_MAX = 480;
export const PLACEHOLDER_DEFAULT = 200;
/** Nothing legitimate reports more than this; a broken fragment that does is clamped, not trusted. */
export const CONTENT_MAX = 4000;
/** While streaming, a half-built widget may not take the whole screen. */
export const STREAMING_VIEWPORT_SHARE = 0.8;
/** Snap to whole pixels: sub-pixel churn would restart the height transition on every report. */
export const HEIGHT_STEP = 2;

export function clampHeight(value: unknown, max: number, min = 1): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.max(min, Math.min(Math.ceil(value), max));
}

/** The model's estimate, used before it reports anything: only a placeholder, so a wild guess is capped. */
export function placeholderHeight(initialHeight: number | undefined): number {
	return clampHeight(initialHeight, PLACEHOLDER_MAX, PLACEHOLDER_MIN) ?? PLACEHOLDER_DEFAULT;
}

/**
 * While streaming, a report may only raise the frame: content that arrived is real, and content that vanished
 * between two morphs (an incomplete tag, a re-render) is an artifact worth ignoring. A shrink waits for the
 * settled document, which also undoes a streaming overshoot.
 */
export function mergeMeasuredHeight(
	previous: number | null,
	reported: unknown,
	options: { readonly growOnly: boolean; readonly max: number },
): number | null {
	const height = clampHeight(reported, options.max);
	if (height === null) return previous;
	const stepped = Math.round(height / HEIGHT_STEP) * HEIGHT_STEP;
	if (previous === null) return stepped;
	// Below the step is noise: keeping the old value avoids restarting the height transition on every report.
	if (Math.abs(height - previous) < HEIGHT_STEP) return previous;
	if (options.growOnly && stepped < previous) return previous;
	return stepped;
}

/** The ceiling a streaming report is clamped to: most of the viewport, never the whole of it. */
export function streamingCeiling(viewportHeight: number): number {
	return Math.max(PLACEHOLDER_MIN, Math.round(viewportHeight * STREAMING_VIEWPORT_SHARE));
}
