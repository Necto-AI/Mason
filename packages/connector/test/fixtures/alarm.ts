/**
 * An events-only connector: an alarm that reports and is never spoken to.
 *
 * It is the shape the split the protocol insists on: everything it sends is an event or a notice, nothing it sends is a
 * submission, and it has nowhere to be sent to. An alert it raises can still be answered, because the alert carried an
 * address — which is the bug the one-envelope rule removed.
 */
import type { ConformanceFixture } from "../../src/testkit/index.ts";

export const alarm: ConformanceFixture = {
	name: "alarm",
	version: "1.0.0",
	faces: {
		kinds: ["alarm.ringing", "alarm.silenced"],
		commands: ["stop", "status"],
	},
};
