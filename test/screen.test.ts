/**
 * The harness's own guarantee, since `test/support/screen.ts` is the thing every terminal test trusts.
 *
 * A capture is a native lease on the current buffer, and the renderer paints on the same loop: a capture that lands
 * while a frame is being presented is refused with `OutputBusy`, which is the failure #177 saw once on CI and twice on
 * a local run of the same commit. The refusal is a fact about the renderer, not about a test, so the harness absorbs it
 * and every test above it can go on reading `harness.frame()`.
 *
 * Both halves are pinned here with a capture that refuses on purpose: the retry that makes the refusal disappear, and
 * the message a reader gets when it does not.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { NativeError, NativeStatus } from "@opentui/core";
import { disposeAll, openScreen } from "./support/screen.ts";

after(disposeAll);

/** What the renderer's lease call throws when the buffer is being presented: `NativeError`, status -13. */
const refused = (): NativeError => new NativeError("ot_session_acquire_buffer_lease", NativeStatus.OutputBusy);

test("a capture the renderer refuses is taken again, and the test never sees the refusal", async () => {
	const harness = await openScreen();
	const capture = harness.setup.captureCharFrame;
	let refusals = 0;
	harness.setup.captureCharFrame = () => {
		refusals += 1;
		if (refusals === 1) throw refused();
		return capture();
	};
	harness.screen.where({ title: "Welcome", index: 1, total: 7 });
	await harness.settle();
	const frame = await harness.frame();
	assert.equal(refusals, 2, "the first capture was refused and the harness tried again on its own");
	assert.match(frame, /Welcome/, "and the frame that came back is the screen");
	await harness.dispose();
});

test("a capture the renderer never hands back names the renderer, not a status code", async () => {
	const harness = await openScreen({ captureWaitMs: 60 });
	harness.setup.captureCharFrame = () => {
		throw refused();
	};
	await assert.rejects(
		() => harness.frame(),
		/the renderer held its buffer for 60 ms, so the screen was never captured/,
		"the error says what did not happen and how long it waited",
	);
	await harness.dispose();
});
