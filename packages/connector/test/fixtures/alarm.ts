/**
 * An events-only connector: an alarm that reports and is never spoken to.
 *
 * It is the shape that proves the split the protocol insists on. Everything it sends is a fire, nothing it sends is a
 * submission, and it can stop a turn it started without being able to read one.
 */
import type { ConformanceFixture } from "../../src/testkit/index.ts";

export const alarm: ConformanceFixture = {
	name: "alarm",
	version: "1.0.0",
	faces: {
		events: {
			"alarm.ringing": "alarm-ringing",
			"alarm.silenced": "alarm-silenced",
		},
	},
};
