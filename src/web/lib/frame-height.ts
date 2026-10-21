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

/**
 * Whether a report is the fullscreen layout still measuring itself.
 *
 * The fullscreen style gives the document the frame's height and a minimum of it, so a document laid out that way
 * reports at least that much. Leave fullscreen and the iframe's viewport takes a transition to shrink back, and a
 * widget whose own layout was stretched by the viewport goes on filling it: either way the number that comes back
 * describes the overlay, not the height the card has in the transcript, and it must never become that height.
 */
export function isFullscreenEcho(reported: unknown, fullscreenHeight: number | null): boolean {
	if (fullscreenHeight === null) return false;
	if (typeof reported !== "number" || !Number.isFinite(reported)) return false;
	return Math.ceil(reported) >= fullscreenHeight - HEIGHT_STEP;
}

/**
 * The height to hold the document at for the layout pass that leaves fullscreen, or `null` for no pass at all.
 *
 * On the way out the card restores the height it had before the overlay, and that number is the only believable
 * constraint to hand the document. A card that never went fullscreen has no such number, and nothing a widget says
 * is one: unknown, non-numeric, empty or beyond `CONTENT_MAX` is junk, and the answer is to leave the embedded
 * document measuring itself exactly as it always does.
 */
export function restoreHeight(cardHeight: unknown): number | null {
	if (typeof cardHeight !== "number" || !Number.isFinite(cardHeight)) return null;
	const height = Math.ceil(cardHeight);
	if (height < 1 || height > CONTENT_MAX) return null;
	return height;
}

/**
 * Whether a report is taller than the card the pass out of fullscreen is restoring, so it cannot be that card's height.
 *
 * The pass pins the document to the restored height, but the widget's own layout only follows a moment later: a child
 * stamped at the viewport size still overflows the freshly pinned box, and the document measures that overflow before
 * anything in it has re-stamped. Nothing above the restored height is accepted while the pass is in flight. It is a
 * one-pass rule on purpose — a document that really is taller than the card's old height reports again once the pass
 * is over, and the card grows to it.
 */
export function isRestoreEcho(reported: unknown, restoring: number | null): boolean {
	if (restoring === null) return false;
	if (typeof reported !== "number" || !Number.isFinite(reported)) return false;
	return Math.ceil(reported) > restoring + HEIGHT_STEP;
}
