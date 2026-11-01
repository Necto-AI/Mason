/**
 * The widget frame's height policy: the model's estimate is a placeholder, streaming reports may only grow the
 * frame, and the settled document is the one that decides.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CONTENT_MAX,
	clampHeight,
	isFullscreenEcho,
	isRestoreEcho,
	mergeMeasuredHeight,
	PLACEHOLDER_DEFAULT,
	placeholderHeight,
	restoreHeight,
	streamingCeiling,
} from "../src/web/lib/frame-height.ts";

test("the model's estimate is used as the placeholder, within reason", () => {
	assert.equal(placeholderHeight(320), 320);
	assert.equal(placeholderHeight(undefined), PLACEHOLDER_DEFAULT);
	// a wild guess is not allowed to reserve half the screen before anything arrived
	assert.equal(placeholderHeight(5000), 480);
	assert.equal(placeholderHeight(4), 96);
	// a non-number is not an estimate
	assert.equal(placeholderHeight(Number.NaN), PLACEHOLDER_DEFAULT);
});

test("a streaming report grows the frame and never shrinks it", () => {
	const streaming = { growOnly: true, max: CONTENT_MAX };
	assert.equal(mergeMeasuredHeight(null, 569, streaming), 570);
	assert.equal(mergeMeasuredHeight(570, 640, streaming), 640);
	// the same report twice changes nothing, so the CSS transition is not restarted
	assert.equal(mergeMeasuredHeight(640, 641, streaming), 640);
	// partial markup that collapses between two morphs does not drag the frame with it
	assert.equal(mergeMeasuredHeight(640, 120, streaming), 640);
	// garbage leaves the frame alone
	assert.equal(mergeMeasuredHeight(640, undefined, streaming), 640);
	assert.equal(mergeMeasuredHeight(640, Number.POSITIVE_INFINITY, streaming), 640);
});

test("the settled document may shrink the frame again", () => {
	const settled = { growOnly: false, max: CONTENT_MAX };
	// the streaming overshoot is undone
	assert.equal(mergeMeasuredHeight(1400, 360, settled), 360);
	assert.equal(mergeMeasuredHeight(200, 569, settled), 570);
});

test("nothing is trusted past the content ceiling", () => {
	assert.equal(clampHeight(99999, CONTENT_MAX), CONTENT_MAX);
	assert.equal(clampHeight(0, CONTENT_MAX, 50), 50);
	assert.equal(mergeMeasuredHeight(null, 99999, { growOnly: true, max: CONTENT_MAX }), CONTENT_MAX);
});

test("a streaming frame may not take the whole screen", () => {
	assert.equal(streamingCeiling(900), 720);
	assert.equal(streamingCeiling(600), 480);
	// a tiny window still gets a usable frame rather than a sliver
	assert.equal(streamingCeiling(120), 96);
});

test("a report measured in the fullscreen layout is refused as the card's height", () => {
	// the overlay gave the document the frame's height, and the document fills it
	assert.equal(isFullscreenEcho(990, 990), true);
	assert.equal(isFullscreenEcho(1200, 990), true);
	// the report and the remembered geometry may disagree by the height step and still be the same layout
	assert.equal(isFullscreenEcho(988, 990), true);
	assert.equal(isFullscreenEcho(986, 990), false);
	// an embedded card is a card in a transcript, well under the height the overlay had
	assert.equal(isFullscreenEcho(320, 990), false);
	// nothing remembered means no overlay to echo, and garbage is not a measurement
	assert.equal(isFullscreenEcho(990, null), false);
	assert.equal(isFullscreenEcho(undefined, 990), false);
	assert.equal(isFullscreenEcho(Number.POSITIVE_INFINITY, 990), false);
});

test("only a believable card height pins the document for the pass out of fullscreen", () => {
	// the height the card had before the overlay is the one the document re-derives at
	assert.equal(restoreHeight(320), 320);
	assert.equal(restoreHeight(174.2), 175);
	assert.equal(restoreHeight(CONTENT_MAX), CONTENT_MAX);
	// a card that never went fullscreen has no such height, so the embedded measurement is left untouched
	assert.equal(restoreHeight(null), null);
	assert.equal(restoreHeight(undefined), null);
	// and neither is anything else a height: an empty, negative, impossible or over-tall number
	assert.equal(restoreHeight(Number.NaN), null);
	assert.equal(restoreHeight(Number.POSITIVE_INFINITY), null);
	assert.equal(restoreHeight(0), null);
	assert.equal(restoreHeight(-320), null);
	assert.equal(restoreHeight(CONTENT_MAX + 1), null);
	// a string that looks like a number is still not one
	assert.equal(restoreHeight("320"), null);
});

test("while the pass out of fullscreen runs, only the restored height is believed", () => {
	// the document is pinned to 320 and measures the same card, give or take the height step
	assert.equal(isRestoreEcho(320, 320), false);
	assert.equal(isRestoreEcho(322, 320), false);
	// a child the widget has not re-stamped yet still overflows the pin: that is the overlay's stretch, not a card
	assert.equal(isRestoreEcho(1007, 320), true);
	assert.equal(isRestoreEcho(324, 320), true);
	// no pass in flight means no refusal, so a widget that needs more room is always allowed to report it
	assert.equal(isRestoreEcho(1007, null), false);
	assert.equal(isRestoreEcho(undefined, 320), false);
});
