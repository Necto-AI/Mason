/**
 * The widget frame's height policy: the model's estimate is a placeholder, streaming reports may only grow the
 * frame, and the settled document is the one that decides.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clampHeight,
	CONTENT_MAX,
	mergeMeasuredHeight,
	placeholderHeight,
	PLACEHOLDER_DEFAULT,
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
