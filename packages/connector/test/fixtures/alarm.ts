/**
 * An events-only connector: an alarm that reports and is never spoken to.
 *
 * It is the shape the protocol insists on: everything it sends is an event, nothing it sends is a submission, and it
 * holds no conversation — an entry without a `user` grant is served an empty cell, no feed and no controls. Its client
 * is `createEventClient`, whose surface is exactly that. An alert it raises is a row of the conversation a *user*
 * client reads, which is why an events-only connector answers nobody and still reaches a person.
 */
import type { ConformanceFixture } from "../../src/testkit/index.ts";

export const alarm: ConformanceFixture = {
	name: "alarm",
	version: "1.0.0",
	faces: {
		kinds: ["alarm.ringing", "alarm.silenced"],
	},
};
