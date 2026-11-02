/**
 * A tools-only connector: it lends mason one calculator and has no idea a conversation exists.
 *
 * This is the smallest useful connector there is, and the point of it is that half the protocol simply does not apply.
 * It has no reader, so nothing can be delivered to it, and it has no events face, so nothing wakes mason through it.
 */
import type { ConformanceFixture } from "../../src/testkit/index.ts";

export const calculator: ConformanceFixture = {
	name: "calculator",
	version: "1.0.0",
	faces: {
		tools: { url: "https://calculator.internal/mcp" },
	},
};
