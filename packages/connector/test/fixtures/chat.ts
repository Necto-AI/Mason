/**
 * A full connector: a chat that carries a person, sends events, takes controls, and has two places to be sent to.
 *
 * Every capability at once, which is what a real chat is. It is the fixture the whole suite runs against rather than the
 * ones the narrower fixtures skip.
 */
import type { ConformanceFixture } from "../../src/testkit/index.ts";

export const chat: ConformanceFixture = {
	name: "chat",
	version: "1.0.0",
	faces: {
		targets: [
			{ id: "dm", label: "the direct conversation", capabilities: ["text", "markdown", "files"] },
			{ id: "alerts", label: "the alerts channel", capabilities: ["text"] },
		],
		kinds: ["chat.message"],
		commands: ["stop", "compact", "clear", "status"],
	},
	handlers: {
		onDelivery: (delivery) => ({ status: "delivered", detail: `sent to ${delivery.target ?? "the default"}` }),
	},
};
