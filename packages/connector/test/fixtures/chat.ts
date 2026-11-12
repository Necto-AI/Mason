/**
 * A full connector: a chat that carries a person, sends events and takes controls.
 *
 * Every face at once, which is what a real chat is. It is the fixture the whole suite runs against rather than the ones
 * the narrower fixtures skip.
 */
import type { ConformanceFixture } from "../../src/testkit/index.ts";

export const chat: ConformanceFixture = {
	name: "chat",
	version: "1.0.0",
	faces: {
		kinds: ["chat.message"],
		commands: ["stop", "compact", "clear", "status"],
	},
	handlers: {
		onDelivery: (delivery) => ({
			status: "delivered",
			detail: `sent to the conversation behind ${delivery.ref ?? "the connector's default"}`,
		}),
	},
};
