/**
 * A full user connector: a chat that carries a person, lends a tool, fires an event, and can put an approval to somebody.
 *
 * Every face at once, which is what a real chat is. It is the fixture the whole suite runs against rather than the ones
 * the narrower fixtures skip.
 */
import type { ConformanceFixture } from "../../src/testkit/index.ts";

export const chat: ConformanceFixture = {
	name: "chat",
	version: "1.0.0",
	faces: {
		user: {
			actors: [{ externalActorId: "u-8811", displayName: "Denis" }],
			conversations: [
				{ externalConversationId: "-1001234", kind: "room", title: "the room" },
				{ externalConversationId: "8811", kind: "person" },
			],
			capabilities: ["text", "markdown", "files", "approvals", "streaming"],
		},
		tools: { url: "https://chat.internal/mcp" },
		events: { "chat.message": "chat-message" },
	},
};
