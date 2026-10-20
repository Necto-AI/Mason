/**
 * The one Chord contract shared by the browser client and the server host:
 * live `ConversationView` + agent status state, and the owner's control methods.
 */
import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";

/**
 * The names the server and the client have to spell the same way: the tool whose calls are the messages the reader
 * sees, and the entry kind a proactive hook trigger is placed as. Spelled once here, so a rename cannot land on one
 * side of the wire only.
 */
export const MESSAGE_TOOL = "send_to_user";
export const HOOK_ENTRY_KIND = "app.hook";

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
	sandboxedUiEnabled: Type.Boolean(),
	model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
	cwd: Type.Optional(Type.String()),
	hooks: Type.Array(HookSummarySchema),
});
export type AgentStatus = {
	runStatus: RunStatus;
	busy: boolean;
	activeRunTaskId?: string;
	runningTools: string[];
	sandboxedUiEnabled: boolean;
	model?: { provider: string; modelId: string };
	cwd?: string;
	hooks: HookSummary[];
};

/**
 * One row of the reader's transcript.
 *
 * The reader sees the conversation, not the machine that wrote it: their own words, what the agent chose to send them
 * (`send_to_user`), the widgets it built for them, and a coarse notice when a run failed. A trigger leaves no row of
 * its own — a proactive turn is the message it sent, and the schedule that fired it is the schedule's business.
 * Reasoning, tool calls, tool arguments and tool output never cross the wire — they are the model's working notes, and
 * a trace endpoint can expose them later, deliberately and separately.
 */
export const TranscriptItemSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("user"),
		id: Type.String(),
		text: Type.String(),
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
	| { kind: "user"; id: string; text: string; at?: number }
	| { kind: "delivered"; id: string; text: string; failed?: boolean; streaming?: boolean }
	| { kind: "widget"; id: string; streaming: boolean; content: unknown }
	| { kind: "notice"; id: string; text: string };

/** A submission the reader queued and can still withdraw, labelled for them rather than for the machine. */
export const QueuedItemSchema = Type.Object({
	id: Type.Number(),
	mode: Type.String(),
	text: Type.String(),
	withdrawable: Type.Boolean(),
});
export type QueuedItem = { id: number; mode: string; text: string; withdrawable: boolean };

export const AgentService = remote("personal.agent", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("server"),
	variants: {
		owner: {
			state: {
				/** The reader's transcript: their words, what the agent sent, widgets, triggers, coarse notices. */
				transcript: Type.Array(TranscriptItemSchema),
				/** The queue behind the running turn, labelled for the reader. */
				queued: Type.Array(QueuedItemSchema),
				// `status` is reserved by Chord references, so the agent's own status cell is `agentStatus`.
				agentStatus: AgentStatusSchema,
			},
			methods: {
				submit: method(
					Type.Object({
						content: Type.String(),
						whenBusy: Type.Optional(
							Type.Union([Type.Literal("followUp"), Type.Literal("steer"), Type.Literal("reject")]),
						),
					}),
					Type.Object({ submissionId: Type.Number() }),
				),
				withdrawSubmission: method(Type.Object({ submissionId: Type.Number() })),
				abort: method(),
				reset: method(Type.Optional(Type.Object({ handoff: Type.Optional(Type.String()) }))),
				compact: method(Type.Optional(Type.Object({ instructions: Type.Optional(Type.String()) }))),
				fireHook: method(
					Type.Object({
						hookId: Type.String(),
						payload: Type.Optional(Type.String()),
						/** Idempotency key; omit for a gesture such as pressing the transcript's Retry control. */
						requestId: Type.Optional(Type.String()),
					}),
					Type.Object({ submissionId: Type.Number() }),
				),
				toggleHook: method(Type.Object({ hookId: Type.String(), enabled: Type.Boolean() })),
				setSandboxedUiEnabled: method(Type.Object({ enabled: Type.Boolean() })),
			},
		},
	},
});
