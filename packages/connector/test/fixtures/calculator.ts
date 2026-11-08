/**
 * A tools-only connector: it lends mason one calculator and has no idea a conversation exists.
 *
 * This is the smallest useful connector there is, and the point of it is that most of the protocol simply does not
 * apply. It has no target, so nothing can be delivered to it, and no kind, so nothing wakes mason through it.
 */
import type { ConformanceFixture } from "../../src/testkit/index.ts";

export const calculator: ConformanceFixture = {
	name: "calculator",
	version: "1.0.0",
	faces: {},
};
