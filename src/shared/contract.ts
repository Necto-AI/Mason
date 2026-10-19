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
	sandboxedUiEnabled: Type.Boolean(),
	model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
	cwd: Type.Optional(Type.String()),
	hooks: Type.Array(HookSummarySchema),
});
export type AgentStatus = {
	runStatus: RunStatus;
	busy: boolean;
	activeRunTaskId?: string;
	sandboxedUiEnabled: boolean;
	model?: { provider: string; modelId: string };
	cwd?: string;
	hooks: HookSummary[];
};

export const AgentService = remote("personal.agent", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("server"),
	variants: {
		owner: {
			state: {
				/** Raw `ConversationView` from pi-durable: entries + `pi.live` / `pi.inbox` / `pi.usage` / `pi.agent`. */
				view: Type.Unknown(),
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
