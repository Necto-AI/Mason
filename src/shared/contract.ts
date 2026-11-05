/**
 * The names the server and the client spell the same way, and the shapes the projection writes: the reader's
 * transcript, the queue, the agent's status, and the entry kinds it is made of.
 *
 * There is no wire contract here: an interface is a connector and speaks `packages/protocol`. This file holds what is
 * still shared in TypeScript — the entry kinds, the reply tool's name, the delivery reminder, and the shapes the
 * projection builds. Nothing consumes the projection yet; apiary is where it crosses.
 */

/**
 * The names the server and the client have to spell the same way: the one tool whose call is a reply, and the entry
 * kinds the transcript is made of. Spelled once here, so a rename cannot land on one side of the wire only.
 *
 * `reply` is mason's own operation, not a vendor's: it targets the origin a turn came from — the connector that carried
 * the words — and the transcript itself when there is none. No prompt names a vendor tool, and the projection reads the
 * entry the reply commits rather than the call that made it.
 */
export const REPLY_TOOL = "reply";
/** A proactive hook trigger. */
export const HOOK_ENTRY_KIND = "app.hook";
/** A person's words that arrived through a connector, carrying the origin a reply goes back to. */
export const CONNECTOR_ENTRY_KIND = "app.connector";
/** One committed reply: the outbox record, and what the reader sees as a delivered message. */
export const REPLY_ENTRY_KIND = "app.reply";
/** What became of one reply: the acknowledgement, durable, so a restart neither resends nor forgets it. */
export const DELIVERY_ENTRY_KIND = "app.delivery";

/**
 * What the delivery gate says to the model when a turn ends with nothing sent.
 *
 * It is a `pi.user` entry because that is the only role a continuation can add, so the projection drops an entry that
 * reads as one: the reader never sees the reminder, only the answer it produces.
 *
 * One reminder, because there is one operation: `reply` reaches whoever the turn came from, and a turn nobody is
 * waiting on says so in its result rather than being answered in another tool's name.
 */
export const DELIVERY_REMINDER = `${deliveryReminderOpening(REPLY_TOOL)} Send the answer now with \`${REPLY_TOOL}\`, in the words the reader should see.`;

/**
 * Whether a user message is the gate's own nudge rather than something a person typed.
 *
 * The opening sentence is the tell, and it is one sentence for every shape: a person's own line that merely begins with
 * the marker is not a reminder, so nothing anybody typed is dropped from their transcript.
 */
export function isDeliveryReminder(text: string): boolean {
	return DELIVERY_REMINDER_OPENING.test(text.trim());
}

const DELIVERY_REMINDER_OPENING =
	/^\[delivery\] That turn ended without a `[^`\n]+` call, so nothing reached the reader:/;

/** The sentence the reminder opens with: what did not happen, in the name of the tool that did not happen with. */
function deliveryReminderOpening(tool: string): string {
	return `[delivery] That turn ended without a \`${tool}\` call, so nothing reached the reader: not your answer, not
your notes, nothing at all.`;
}

export type HookSummary = {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	intervalMs?: number;
	lastFiredAt?: string;
	fireCount: number;
};

export type RunStatus = "idle" | "generating" | "running_tools" | "retrying" | "compacting";

export type AgentStatus = {
	runStatus: RunStatus;
	busy: boolean;
	activeRunTaskId?: string;
	runningTools: string[];
	model?: { provider: string; modelId: string };
	cwd?: string;
	hooks: HookSummary[];
};

/**
 * How long a name in a stored prefix may be. Long enough for "Александра Петрова", short enough to read as
 * `[from <name>]` in a prompt.
 *
 * It lives here because the prefix's own pattern is what enforces it: the name mason wrote into a message and the name
 * the parser reads back have to be the same length, so the two cannot drift into disagreeing about what a prefix is.
 */
export const NAME_MAX = 40;

/**
 * How a message said who wrote it, in the text the model read.
 *
 * This is history, read-only. A home that predates the single-user cutover stored `[from Ilya] …` as the text of a
 * `pi.user` message, because a shared transcript needed an author the model could see. Mason works for one person now
 * and writes no prefix, and the messages it wrote before keep theirs: rewriting stored text at read time would change
 * what somebody actually said, which the room vocabulary refused on the record (#126). `splitAuthor` reads them back out
 * so an old transcript still shows the name it was written with; nothing writes one any more.
 */
export const AUTHOR_PREFIX = new RegExp(`^\\[from ([^[\\]\\n]{1,${NAME_MAX}})\\] `);

/** The author a stored message names, and the text without the prefix. A message with no prefix has no author. */
export function splitAuthor(text: string): { readonly text: string; readonly author?: string } {
	const match = AUTHOR_PREFIX.exec(text);
	if (match === null) return { text };
	return { text: text.slice(match[0].length), author: match[1] as string };
}

/**
 * One row of the reader's transcript.
 *
 * The reader sees the conversation, not the machine that wrote it: their own words, what the agent chose to send them
 * (`reply`), and a coarse notice when a run failed. A trigger leaves no row of its own — a proactive turn is the message it sent, and the schedule that fired it is the schedule's business.
 * Reasoning, tool calls, tool arguments and tool output never cross the wire — they are the model's working notes, and
 * a trace endpoint can expose them later, deliberately and separately.
 */
export type TranscriptItem =
	| { kind: "user"; id: string; text: string; author?: string; at?: number }
	| { kind: "delivered"; id: string; text: string; failed?: boolean; streaming?: boolean }
	| { kind: "notice"; id: string; text: string };

/** A submission the reader queued and can still withdraw, labelled for them rather than for the machine. */
export type QueuedItem = { id: number; mode: string; text: string; author?: string; withdrawable: boolean };
