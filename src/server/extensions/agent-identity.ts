/**
 * Who the agent is: workspace `SOUL.md` (or the built-in preamble), the working directory, how to behave when an
 * event hook wakes it, and the one channel its words reach the reader through.
 */
import type { Context } from "@earendil-works/chord";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export const DEFAULT_PREAMBLE = `You are a proactive personal assistant with durable memory of this conversation.
You are woken by event hooks, not only by the user: when something needs attention you reach out first, in your own words.
You work in a real workspace through your tools (\`read\`, \`write\`, \`edit\`, \`bash\`), so verify before you claim.
Be concise. Say what you did, what you found, and what you need; skip ceremony.`;

export const PROACTIVE_GUIDELINES = `Some user turns are event hook triggers: they start with "[EVENT HOOK: <name>]".
When you receive one, you were woken by a schedule or an external trigger, not by the user:
- Act, do not ask permission for work the hook's name and description already authorize.
- Use your tools when a tool answer is more reliable than memory or guessing.
- Address the user directly with what happened and why you are reaching out, then what you need from them (if anything).
- If nothing needs attention, say so in one line; do not pad a check-in into a report.`;

/**
 * The delivery invariant, in every turn: the chat renders messages out of `send_to_user` calls only, so prose the model
 * writes is working notes nobody reads. Slice 2 owns prompt hygiene; this is the one rule the client depends on.
 */
export const DELIVERY_INVARIANT = `Only messages sent via \`send_to_user\` are seen by the user. All other text is working notes.`;

/** Where the agent's identity text lives, relative to the workspace the tools see. */
const SOUL_FILES = ["SOUL.md", "AGENT_SOUL.md"] as const;

async function readSoul(env: ExecutionEnv | undefined, context: Context): Promise<string | undefined> {
	if (env === undefined) return undefined;
	for (const name of SOUL_FILES) {
		const result = await env.readTextFile(name, context);
		if (result.ok && result.value.trim() !== "") return result.value.trim();
	}
	return undefined;
}

export const AgentIdentity = defineExtension({
	name: "agent-identity",
	sections: [
		section("preamble", async (input, context) => (await readSoul(input.env, context)) ?? DEFAULT_PREAMBLE, {
			tag: false,
		}),
		section("cwd", (input) => input.env?.cwd),
		section("proactive_guidelines", () => PROACTIVE_GUIDELINES),
		section("delivery", () => DELIVERY_INVARIANT),
	],
});
