/**
 * The mason connector protocol, v1, as TypeScript sees it.
 *
 * `schemas/protocol.v1.json` is the normative document: a connector in another language is written against that file,
 * not against this one. This module is the same shapes spelled for TypeScript, plus the four things every
 * implementation ends up hard-coding wrongly when they are only prose: the major version, the method names, the error
 * codes, and the metadata key an MCP tool declares its approval marker under.
 *
 * Nothing here imports mason. A connector written against this package has no path into mason's source tree.
 */

/**
 * The major version. One major is negotiated per socket, and a connector that speaks only another major is refused at
 * the handshake rather than degraded: a half-understood contract is worse than no contract.
 */
export const PROTOCOL_MAJOR = 1;

/** The minor this implementation speaks. Additions stay inside the major, so a peer's newer minor is never an error. */
export const PROTOCOL_MINOR = 0;

/** The `$id` of the normative schema document, as published. */
export const SCHEMA_ID = "https://mason.dev/connector/protocol.v1.json";

/** The MCP methods, exactly as they appear on the wire. Spelled once so two sides cannot disagree about a string. */
export const METHOD = {
	hello: "mason/hello",
	submit: "mason/submit",
	fire: "mason/fire",
	control: "mason/control",
	interactionAnswer: "mason/interaction.answer",
	stateSubscribe: "mason/state.subscribe",
	deliveryStart: "connector/delivery.start",
	deliveryDelta: "connector/delivery.delta",
	deliveryFinal: "connector/delivery.final",
	deliveryCancel: "connector/delivery.cancel",
	interactionRequest: "connector/interaction.request",
	stateSnapshot: "connector/state.snapshot",
	stateDelta: "connector/state.delta",
	ping: "connector/ping",
} as const;

export type Method = (typeof METHOD)[keyof typeof METHOD];

/**
 * The stable error codes. A connector branches on `code` and shows `message` to a person, which is why the two are
 * separate fields and why the sentence is allowed to change without breaking anybody.
 */
export const ERROR_CODE = {
	protocolMismatch: "mason.protocol_mismatch",
	faceNotGranted: "mason.face_not_granted",
	scopeNotGranted: "mason.scope_not_granted",
	actorUnknown: "mason.actor_unknown",
	conversationNotPermitted: "mason.conversation_not_permitted",
	kindNotPermitted: "mason.kind_not_permitted",
	rateLimited: "mason.rate_limited",
	queueOverflow: "mason.queue_overflow",
	invalidRequest: "mason.invalid_request",
	notAuthenticated: "mason.not_authenticated",
	unknownPermission: "mason.unknown_permission",
	internal: "mason.internal",
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** JSON-RPC's own codes, which a receiver of a frame has to know as well as mason's. */
export const RPC_ERROR = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
} as const;

/**
 * The key an MCP tool declares its approval marker under.
 *
 * The connector author writes it because that service knows what an operation does. Mason reads it and does not infer
 * risk from a tool's name, and it does not trust MCP's own annotations as authority: an annotation is a claim, and this
 * is the one claim the operator can decide to trust per connector.
 */
export const APPROVAL_META_KEY = "dev.mason/approval";

/** The two markers. A tool with no marker, or one mason does not know, is `required`. */
export const APPROVAL = { required: "required", notRequired: "not_required" } as const;

export type ApprovalMarker = (typeof APPROVAL)[keyof typeof APPROVAL];

export function isApprovalMarker(value: unknown): value is ApprovalMarker {
	return value === APPROVAL.required || value === APPROVAL.notRequired;
}

export type Capability = "text" | "markdown" | "files" | "approvals" | "widgets" | "streaming";

export const CAPABILITIES: readonly Capability[] = ["text", "markdown", "files", "approvals", "widgets", "streaming"];

export type StateScope = "status" | "presence" | "projection" | "tools";

export const STATE_SCOPES: readonly StateScope[] = ["status", "presence", "projection", "tools"];

export type FaceName = "user" | "tools" | "events";

export type SubmissionMode = "followUp" | "steer" | "reject";

export type ControlOp = "stop" | "compact" | "clear" | "status";

export const CONTROL_OPS: readonly ControlOp[] = ["stop", "compact", "clear", "status"];

export interface ProtocolVersion {
	readonly major: number;
	readonly minors?: readonly number[];
}

export interface ExternalActor {
	readonly externalActorId: string;
	readonly displayName?: string;
}

export interface ExternalConversation {
	readonly externalConversationId: string;
	readonly kind: "person" | "room";
	readonly title?: string;
}

export interface Origin {
	readonly connector: string;
	readonly externalConversationId: string;
	readonly externalMessageId?: string;
	readonly externalActorId?: string;
}

export type ContentBlock =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "markdown"; readonly text: string }
	| {
			readonly type: "file";
			readonly contentId: string;
			readonly name?: string;
			readonly mimeType?: string;
			readonly size?: number;
			readonly caption?: string;
	  }
	| { readonly type: "widget"; readonly content: unknown }
	| { readonly type: "notice"; readonly text: string };

export interface Limits {
	readonly submissionsPerMinute: number;
	readonly firesPerMinute: number;
	readonly controlsPerMinute: number;
	readonly attachmentsPerMinute: number;
	readonly attachmentBytes?: number;
	readonly attachmentTtlMs?: number;
}

export interface FacesDeclaration {
	readonly user?: {
		readonly actors?: readonly ExternalActor[];
		readonly conversations?: readonly ExternalConversation[];
		readonly capabilities?: readonly Capability[];
	};
	readonly tools?: { readonly url?: string };
	readonly events?: { readonly kinds?: readonly string[] };
}

export interface HelloRequest {
	readonly protocol: ProtocolVersion;
	readonly connector: { readonly name: string; readonly version: string };
	readonly faces: FacesDeclaration;
}

export interface GrantedUserFace {
	readonly actors: readonly ExternalActor[];
	readonly conversations: readonly ExternalConversation[];
	readonly capabilities: readonly Capability[];
}

export interface HelloResult {
	readonly protocol: ProtocolVersion;
	readonly connector: string;
	readonly faces: {
		readonly user?: GrantedUserFace;
		readonly tools?: { readonly url: string };
		readonly events?: { readonly hooks: Readonly<Record<string, string>> };
	};
	readonly inactive?: readonly { readonly face: FaceName; readonly reason: string }[];
	readonly capabilities: readonly Capability[];
	/**
	 * The controls this socket may spend on `mason/control`, as the operator granted them. Absent is none.
	 *
	 * The grant is the ceiling and this is the connector's view of it: without the list a connector that was not granted
	 * `stop` learns it only by spending a call that is refused, and cannot tell a missing permission from a typo.
	 */
	readonly commands?: readonly ControlOp[];
	readonly limits: Limits;
}

export interface Accepted {
	readonly accepted: boolean;
	readonly id: string;
	readonly entryId?: string;
	readonly duplicate?: boolean;
}

export interface SubmitParams {
	readonly submissionId: string;
	readonly origin: Origin;
	readonly actor?: ExternalActor;
	readonly content: readonly ContentBlock[];
	readonly mode?: SubmissionMode;
	readonly capabilities?: readonly Capability[];
	readonly approver?: boolean;
}

export interface FireParams {
	readonly fireId: string;
	readonly kind: string;
	readonly payload: unknown;
	readonly origin?: Origin;
	readonly summary?: string;
}

export interface ControlParams {
	readonly op: ControlOp;
	readonly requestId?: string;
	readonly instructions?: string;
	readonly by?: ExternalActor;
}

export interface ControlResult {
	readonly handled: boolean;
	readonly op: ControlOp;
	readonly reply?: string;
	readonly status?: Readonly<Record<string, unknown>>;
}

export interface InteractionAnswerParams {
	readonly permissionId: string;
	readonly answer: "allow" | "deny";
	readonly by?: ExternalActor;
}

export interface InteractionAnswerResult {
	readonly settled: boolean;
	readonly reason?: string;
}

export interface StateSubscribeParams {
	readonly scopes: readonly StateScope[];
	readonly since?: number;
}

export interface StateSubscribeResult {
	readonly scopes: readonly StateScope[];
	readonly seq: number;
	readonly resumed?: boolean;
}

/** A proactive or explicit destination. Absent means "back to the origin", which is the only default there is. */
export interface DeliveryTarget {
	readonly connector: string;
	readonly externalConversationId: string;
}

export interface DeliveryStartParams {
	readonly deliveryId: string;
	readonly origin: Origin;
	readonly seq: number;
	readonly blocks: readonly ContentBlock[];
	readonly target?: DeliveryTarget;
}

export interface DeliveryDeltaParams {
	readonly deliveryId: string;
	readonly seq: number;
	readonly blocks: readonly ContentBlock[];
}

export interface DeliveryFinalParams {
	readonly deliveryId: string;
	readonly origin: Origin;
	readonly seq: number;
	readonly blocks: readonly ContentBlock[];
	readonly target?: DeliveryTarget;
}

/**
 * What a connector answers a delivery with. `uncertain` exists because a lost acknowledgement and a lost send look
 * identical from mason's side, and guessing between them either loses a message or sends it twice.
 */
export type DeliveryAck =
	| { readonly status: "delivered"; readonly detail?: string; readonly external?: unknown }
	| { readonly status: "duplicate"; readonly detail?: string; readonly external?: unknown }
	| { readonly status: "uncertain"; readonly detail: string; readonly external?: unknown }
	| { readonly status: "rejected"; readonly detail: string; readonly external?: unknown };

export interface InteractionRequestParams {
	readonly permissionId: string;
	readonly tool: { readonly name: string; readonly connector?: string };
	readonly arguments: unknown;
	readonly reason: string;
	readonly answers: readonly ("allow" | "deny")[];
	readonly origin: Origin;
	readonly blocks?: readonly ContentBlock[];
}

export interface InteractionAck {
	readonly delivered: boolean;
	readonly surface?: string;
	readonly detail?: string;
}

export interface ProjectionItem {
	readonly [key: string]: unknown;
}

export interface ProjectionState {
	readonly items: readonly ProjectionItem[];
	readonly queued?: readonly ProjectionItem[];
}

export interface StateSnapshotParams {
	readonly seq: number;
	readonly scopes: readonly StateScope[];
	readonly status?: Readonly<Record<string, unknown>>;
	readonly presence?: Readonly<Record<string, unknown>>;
	readonly projection?: ProjectionState;
	readonly tools?: { readonly running: readonly string[] };
}

export interface StateDeltaParams {
	readonly seq: number;
	readonly scope: StateScope;
	readonly op: "set" | "push" | "reset";
	readonly value?: unknown;
	readonly path?: string;
}

export interface AttachmentUploadResult {
	readonly contentId: string;
	readonly size: number;
	readonly expiresAt?: number;
}

/** The `data` of a JSON-RPC error, so a connector can branch on the code instead of parsing a sentence. */
export interface ProtocolErrorData {
	readonly code: ErrorCode;
	readonly message: string;
	readonly retryable?: boolean;
	readonly retryAfterMs?: number;
	readonly field?: string;
}

export function isProtocolErrorData(value: unknown): value is ProtocolErrorData {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.code !== "string" || typeof record.message !== "string") return false;
	return Object.values(ERROR_CODE).includes(record.code as ErrorCode);
}

/**
 * Whether two peers can talk. A matching major is the whole test: minors are additive by construction, so the newer
 * side keeps what it knows and the older one ignores the rest.
 */
export function versionsCompatible(
	theirs: ProtocolVersion,
	ours: ProtocolVersion = { major: PROTOCOL_MAJOR },
): boolean {
	return theirs.major === ours.major;
}

/** The highest minor both sides implement, which is what a `hello` answers with. Absent on either side is minor 0. */
export function negotiateMinor(
	theirs: ProtocolVersion,
	ours: ProtocolVersion = { major: PROTOCOL_MAJOR, minors: [PROTOCOL_MINOR] },
): number {
	const mine = ours.minors ?? [PROTOCOL_MINOR];
	const yours = theirs.minors ?? [0];
	const shared = mine.filter((minor) => yours.includes(minor));
	return shared.length === 0 ? 0 : Math.max(...shared);
}
