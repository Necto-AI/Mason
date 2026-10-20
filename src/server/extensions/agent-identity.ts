/**
 * Who the agent is: `~/.mason/soul.md` as the first section of the prompt, the working directory, how to behave when
 * an event hook wakes it, and the one channel its words reach the reader through.
 *
 * `soul.md` replaces the default preamble a coding agent opens with ("you are a personal coding agent…"). It is the
 * agent's own voice, so it is written by the person the agent works for, it stays short, and it is fixed for the
 * conversation: the prompt prefix must not change under a running turn.
 */
import { defineExtension, section } from "@earendil-works/pi-durable";
import { currentHouse, readHouseFile } from "../house.ts";

/** What a fresh install starts from, and what `~/.mason/soul.md` is created with. Short on purpose. */
export const DEFAULT_SOUL = `You are mason, Denis's personal assistant: always on, and able to reach him first.
You keep his work moving while he is elsewhere. Be concise, concrete and calm; say what you did, what you found and what
you need, and skip ceremony.
Prefer what you already know; then the workspace and your tools; then an API; then search; then a browser; then a
desktop. Ask Denis last: interrupting him costs more than doing the work.
Verify before you claim. If you did not check it, say so.`;

/** The cost ladder is behaviour the product leans on, so it is in the default even when a soul is supplied. */
export const PROACTIVE_GUIDELINES = `Some user turns are event hook triggers: they start with "[EVENT HOOK: <name>]".
When you receive one, you were woken by a schedule or an external trigger, not by the user:
- Act, do not ask permission for work the hook's name and description already authorize.
- Use your tools when a tool answer is more reliable than memory or guessing.
- Address the user directly with what happened and why you are reaching out, then what you need from them (if anything).
- If nothing needs attention, say so in one line; do not pad a check-in into a report.`;

/**
 * The delivery invariant, in every turn: the chat renders messages out of `send_to_user` calls only, so prose the model
 * writes is working notes nobody reads.
 */
const DELIVERY_INVARIANT = `Only messages sent via \`send_to_user\` are seen by the user. All other text is working notes.`;

export const AgentIdentity = defineExtension({
	name: "agent-identity",
	sections: [
		// Tag-less: this is the system prompt's opening, not a labelled block inside it.
		section("soul", async () => (await readHouseFile(currentHouse().soul)) ?? DEFAULT_SOUL, { tag: false }),
		section("cwd", (input) => input.env?.cwd),
		section("proactive_guidelines", () => PROACTIVE_GUIDELINES),
		section("delivery", () => DELIVERY_INVARIANT),
	],
});
