/**
 * The shapes the panel and the server spell the same way: the reader's transcript, the queue, the agent's status, and
 * the entry kinds the projection is made of.
 *
 * There is no wire contract here any more (#103). The console's Chord service is gone with the console: a browser reads
 * `GET /api/admin/state` (`shared/admin.ts`), and a person speaks through a connector. This file stayed because every
 * shape below is still shared — the projection writes them, the panel renders them, the connector door mirrors them.
 */
import { Type } from "typebox";

/**
 * The names the server and the client have to spell the same way: the one tool whose call is a reply, and the entry
 * kinds the transcript is made of. Spelled once here, so a rename cannot land on one side of the wire only.
 *
 * `reply` is mason's own operation, not a vendor's: it targets the origin a turn came from — the connector that carried
 * the words — and the operator console when there is none. No prompt names a vendor tool, and the projection reads the
 * entry the reply commits rather than the call that made it.
 */
export const REPLY_TOOL = "reply";
export const WIDGET_TOOL = "generateSandboxedUi";
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

export const HookSummarySchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	description: Type.String(),
	enabled: Type.Boolean(),
	intervalMs: Type.Optional(Type.Number()),
	lastFiredAt: Type.Optional(Type.String()),
	fireCount: Type.Number(),
});
export type HookSummary = {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	intervalMs?: number;
	lastFiredAt?: string;
	fireCount: number;
};

export const RunStatusSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("generating"),
	Type.Literal("running_tools"),
	Type.Literal("retrying"),
	Type.Literal("compacting"),
]);
export type RunStatus = "idle" | "generating" | "running_tools" | "retrying" | "compacting";

export const AgentStatusSchema = Type.Object({
	runStatus: RunStatusSchema,
	busy: Type.Boolean(),
	activeRunTaskId: Type.Optional(Type.String()),
	/** The tools of the running round, by name. No arguments, no output: what runs is not what the reader reads. */
	runningTools: Type.Array(Type.String()),
	model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
	cwd: Type.Optional(Type.String()),
	hooks: Type.Array(HookSummarySchema),
});
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
 * How long a name may be, as a speaker label and as something the transcript can carry. Long enough for "Александра
 * Петрова", short enough to read as `[from <name>]` in a prompt.
 *
 * It lives here because the prefix's own pattern is what enforces it as well: a name the roster accepts and a name the
 * parser reads back have to be the same length, so the two cannot drift into disagreeing about what a prefix is.
 */
export const NAME_MAX = 40;

/**
 * How a message says who wrote it, in the text the model reads.
 *
 * The durable entry is a `pi.user` message and nothing else, so the author has to live in the text or not exist. It
 * lives there as a prefix — `[from Ilya] …` — which is also what the model sees: a shared transcript where the model
 * has to know who decided what cannot afford an author it only sometimes notices. The server writes the prefix and
 * `projection.ts` parses it back out, so the wire keeps one source of truth and an old transcript written before the
 * roster existed still reads correctly. A prefix a client typed is not read back as an author: `withAuthor` drops it
 * for anyone without a name, so only a name the server wrote can reach a bubble.
 */
export const AUTHOR_PREFIX = new RegExp(`^\\[from ([^[\\]\\n]{1,${NAME_MAX}})\\] `);

/**
 * The text the server stores for a submission: the prefix and the words when it knows who spoke, the words alone when
 * it does not.
 *
 * An unnamed device — or any token client — can type a prefix itself. Dropping it here is what keeps the name on a
 * message the server's claim: nothing stored can name an author the server did not write. It is deliberately not done
 * in `projection.ts`, which also reads history written before this rule, and rewriting that would change what somebody
 * actually typed.
 */
export function withAuthor(text: string, author: string | undefined): string {
	if (author !== undefined) return `[from ${author}] ${text}`;
	// A leading space or newline is enough to stop the byte-exact pattern matching, and a raw client can send one. The
	// prefix is dropped wherever the message *starts* with it, indentation included; text without one keeps every
	// character it came with, which is the case that matters for what a person actually typed.
	const lead = /^\s*/.exec(text)?.[0] ?? "";
	const match = AUTHOR_PREFIX.exec(text.slice(lead.length));
	return match === null ? text : text.slice(lead.length + match[0].length);
}

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
 * (`reply`), the widgets it built for them, and a coarse notice when a run failed. A trigger leaves no row of
 * its own — a proactive turn is the message it sent, and the schedule that fired it is the schedule's business.
 * Reasoning, tool calls, tool arguments and tool output never cross the wire — they are the model's working notes, and
 * a trace endpoint can expose them later, deliberately and separately.
 */
export const TranscriptItemSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("user"),
		id: Type.String(),
		text: Type.String(),
		/** Who on the roster said it. Absent for an unnamed device, and for every message written before today. */
		author: Type.Optional(Type.String()),
		at: Type.Optional(Type.Number()),
	}),
	Type.Object({
		kind: Type.Literal("delivered"),
		id: Type.String(),
		text: Type.String(),
		failed: Type.Optional(Type.Boolean()),
		streaming: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		kind: Type.Literal("widget"),
		id: Type.String(),
		streaming: Type.Boolean(),
		content: Type.Unknown(),
	}),
	Type.Object({ kind: Type.Literal("notice"), id: Type.String(), text: Type.String() }),
]);
export type TranscriptItem =
	| { kind: "user"; id: string; text: string; author?: string; at?: number }
	| { kind: "delivered"; id: string; text: string; failed?: boolean; streaming?: boolean }
	| { kind: "widget"; id: string; streaming: boolean; content: unknown }
	| { kind: "notice"; id: string; text: string };

/** A submission the reader queued and can still withdraw, labelled for them rather than for the machine. */
export const QueuedItemSchema = Type.Object({
	id: Type.Number(),
	mode: Type.String(),
	text: Type.String(),
	/** Whoever queued it: on a shared transcript the queue belongs to a person, not to the server. */
	author: Type.Optional(Type.String()),
	withdrawable: Type.Boolean(),
});
export type QueuedItem = { id: number; mode: string; text: string; author?: string; withdrawable: boolean };
