/**
 * The operator panel's wire: what a granted device is sent, and what it writes back.
 *
 * The panel is a browser application served by mason (`docs/SPEC.md` §4.2/§4.3), and this file is the one place its shape is
 * spelled. Both sides import it — the server builds these values, the panel renders them — so a renamed field cannot
 * land on one side of the wire only. Nothing here imports a node module: the panel bundles this file into the browser.
 *
 * Two rules are the reason the file exists at all:
 *
 * - **inspection is granted, not assumed.** `PanelState` carries a key only when the device's grant covers it, so the
 *   trace is *absent* from a state built for a device without `trace`, not hidden by the client. A field that is
 *   sometimes missing is a field a client cannot pretend to have.
 * - **a secret is written, never read.** A token and a connector credential come back exactly once,
 *   from the mint that made them. The state names what exists by id and label; nothing it holds is replayable.
 */
import type { AgentStatus, HookSummary, QueuedItem, TranscriptItem } from "./contract.ts";

/**
 * What a credential may do in the panel. Administration and inspection are different powers, and the trace is a third:
 * a phone that reads the conversation is not a laptop that holds the credentials, and the raw entries are the model's
 * working notes rather than what a person said.
 */
export type OperatorGrant = "conversation" | "trace" | "admin" | "approve";

/** Every grant mason has, in the order the panel shows them. */
export const OPERATOR_GRANTS: readonly OperatorGrant[] = ["conversation", "admin", "approve", "trace"];

export function isOperatorGrant(value: unknown): value is OperatorGrant {
	return typeof value === "string" && (OPERATOR_GRANTS as readonly string[]).includes(value);
}

export function hasGrant(grants: readonly OperatorGrant[], grant: OperatorGrant): boolean {
	return grants.includes(grant);
}

/**
 * The grants a stored credential holds: the names mason knows, and nothing else. A record written before grants existed
 * has none, which is why every reader goes through this — a file that predates the key grants nothing until it is
 * migrated (`npm run doctor -- migrate`).
 */
export function grantsOf(record: { readonly grants?: readonly OperatorGrant[] }): readonly OperatorGrant[] {
	return Array.isArray(record.grants) ? record.grants.filter(isOperatorGrant) : [];
}

/** A device as the access page lists it. The credential itself was printed once, when it was minted. */
export interface PanelToken {
	readonly id: string;
	readonly label: string;
	readonly createdAt: string;
	readonly grants: readonly OperatorGrant[];
}

/** A connector's credential: which entry it speaks for, and when it was issued. Never the credential. */
export interface PanelCredential {
	readonly id: string;
	readonly connector: string;
	readonly createdAt: string;
}

/** A room a connector's user face may carry words in (`mason-protocol`'s `ExternalConversation`). */
export interface PanelConversationGrant {
	readonly externalConversationId: string;
	readonly kind: "person" | "room";
	readonly title?: string;
}

/** The user face's grant, as the connector page edits it. */
export interface PanelUserGrant {
	/** The external actor id that speaks for the person this bot works for. Absent: no actor may speak through it. */
	readonly owner?: string;
	readonly conversations: readonly PanelConversationGrant[];
	/** The content the connector may claim it renders, when the operator narrowed it. */
	readonly capabilities?: readonly string[];
}

/** The operator's ask/allow/deny rules for a connector's tools. `deny` beats `ask` beats `allow`. */
export interface PanelPolicy {
	readonly allow?: readonly string[];
	readonly ask?: readonly string[];
	readonly deny?: readonly string[];
}

/** One entry's connector block: a ceiling, never a wish. */
export interface PanelConnectorGrant {
	readonly user?: PanelUserGrant;
	/** The operator's `kind` → hook map for the events face. */
	readonly events?: { readonly hooks: Readonly<Record<string, string>> };
	readonly state: readonly string[];
	/** The controls this connector may spend on `mason/control`, out of the protocol's closed set. */
	readonly commands?: readonly string[];
	readonly trustMarkers: boolean;
	readonly policy?: PanelPolicy;
}

/**
 * What the connector page writes for the connector block. An absent key is left alone; `null` where a face is allowed
 * removes it, and `null` inside a face removes that one key — the panel edits a grant, it does not resend the file.
 */
export interface ConnectorGrantInput {
	readonly user?: {
		/** The one actor whose words are the owner's. `null` clears it, and every actor submission is then refused. */
		readonly owner?: string | null;
		readonly conversations?: readonly PanelConversationGrant[];
		/** `null` puts the connector's own claim back in charge. */
		readonly capabilities?: readonly string[] | null;
	} | null;
	readonly events?: { readonly hooks?: Readonly<Record<string, string>> } | null;
	readonly state?: readonly string[];
	/** `[]` takes the vocabulary away again; the names are the protocol's closed set. */
	readonly commands?: readonly string[];
	readonly trustMarkers?: boolean;
	/** `null` removes every rule; a list sent as `[]` is a rule that matches nothing. */
	readonly policy?: PanelPolicy | null;
}

/** One integration as the panel edits it and reports it. */
export interface PanelConnector {
	readonly name: string;
	readonly enabled: boolean;
	readonly description: string | null;
	readonly tools: { readonly url: string; readonly required: boolean; readonly hasCredential: boolean } | null;
	readonly connector: PanelConnectorGrant | null;
}

/** What the boot's connections came to, for one integration. */
export interface PanelHealth {
	readonly name: string;
	readonly enabled: boolean;
	readonly hasTools: boolean;
	readonly connected: boolean;
	readonly tools: number;
	readonly error: string | null;
}

/** The mason tool a question is about: the call, the service it reaches, and the service's own name for it. */
export interface PanelTool {
	readonly name: string;
	readonly connector?: string;
	readonly tool?: string;
}

/** A pending tool question, as the approvals page answers it. */
export interface PanelPermission {
	readonly permissionId: string;
	readonly tool: PanelTool;
	readonly arguments: unknown;
	readonly reason: string;
	readonly answers: readonly ("allow" | "deny")[];
	readonly origin: unknown;
	readonly askedAt: string | null;
}

/** One durable entry, verbatim: the trace is the record, not a rendering of it. */
export interface TraceEntry {
	readonly id: string;
	readonly kind: string;
	/** The messages this entry contributed to the model's context, exactly as stored. */
	readonly model?: readonly unknown[];
	/** The application payload: a reply, a hook, a delivery, a question, a command. */
	readonly data?: unknown;
	/** The first entry of the active context, when this entry moved it. */
	readonly head?: string;
	/** Context-only overrides of earlier entries: a prompt that changed without a message being appended. */
	readonly edits?: readonly unknown[];
	readonly byTaskId?: string;
}

export interface Trace {
	readonly conversationId: string;
	readonly entries: readonly TraceEntry[];
	/** Entries per kind, in the order the conversation first used them: the trace's table of contents. */
	readonly kinds: readonly { readonly kind: string; readonly count: number }[];
}

/**
 * What one `/api/admin/state` answer holds. A granted area is a key; an area this device may not see is absent, and the
 * client renders what it was given rather than asking again for what it was refused.
 */
export interface PanelState {
	readonly now: string;
	readonly session: {
		readonly device: { readonly id: string; readonly label: string };
		readonly grants: readonly OperatorGrant[];
	};
	readonly conversation?: {
		readonly status: AgentStatus;
		readonly transcript: readonly TranscriptItem[];
		readonly queued: readonly QueuedItem[];
	};
	readonly trace?: Trace;
	readonly permissions?: readonly PanelPermission[];
	readonly config?: {
		readonly connectors: readonly PanelConnector[];
		readonly health: readonly PanelHealth[];
		readonly tokens: readonly PanelToken[];
		readonly credentials: readonly PanelCredential[];
		readonly hooks: readonly HookSummary[];
		readonly commands: readonly string[];
		readonly capabilities: readonly string[];
		readonly stateScopes: readonly string[];
		/** The file differs from what this process booted with: the change lands on the next start. */
		readonly restartRequired: boolean;
		readonly grants: readonly OperatorGrant[];
	};
}

/** What a connector page writes. An absent key is left alone; `null` where a face is allowed removes it. */
export interface ConnectorPatch {
	readonly enabled?: boolean;
	readonly description?: string;
	readonly tools?: { readonly url: string; readonly required?: boolean; readonly credential?: string } | null;
	readonly connector?: ConnectorGrantInput | null;
}
