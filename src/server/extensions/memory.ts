/**
 * `remember`: the one write into durable memory.
 *
 * A fact Denis tells the agent — a preference, a standing arrangement, something that happened — is appended to today's
 * log as one dated line and committed, so it is a file he can read and revert. The profile is curated separately, by
 * `write`; this tool only accumulates.
 *
 * Nothing is recalled through a search tool: the log is read with `read` when the agent needs history, which is the
 * whole reason it is plain markdown.
 */
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { appendFact, ensureRepository, currentHouse } from "../house.ts";

const RememberParams = Type.Object({
	fact: Type.String({
		minLength: 1,
		description: "One thing worth keeping, in one sentence: a preference, a decision, or something that happened.",
	}),
});

export const rememberTool = defineTool({
	name: "remember",
	description:
		"Keep one durable fact about Denis or his work. Use it when he tells you a preference, makes an arrangement, or when something must not be forgotten; do not use it for the mechanics of a conversation.",
	parameters: RememberParams,
	// An interrupted call settles as an error instead of rerunning: the same fact twice is noise in the log.
	replay: "unsafe",
	execute: async ({ fact }) => {
		const paths = currentHouse();
		await ensureRepository(paths.home);
		const path = await appendFact(paths, fact);
		return {
			output: [{ type: "text", text: `Remembered in ${path}` }],
			details: { path, length: fact.length },
		};
	},
});

export const Memory = defineExtension({
	name: "memory",
	tools: [rememberTool],
});
