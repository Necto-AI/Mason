/**
 * The mason connector protocol, v1, as Chord contracts.
 *
 * A connector is a Chord host. It opens one socket to mason, and everything it does happens through two contracts:
 *
 * - **`mason.peer`** is served by mason and reached by the connector. It is how a connector hands mason something — a
 *   person's words, an event, a notice — and how it asks for a control. Its `session` state is the handshake: the grant
 *   as the connector sees it, readable once the reference is ready.
 * - **`mason.connector`** is served by the connector at `connector:<name>` and reached by mason. It is one method,
 *   `deliver`, and its answer is the acknowledgement.
 *
 * There are no frames of our own: no envelope, no sequence number, no method registry. What a peer may call is what the
 * contract declares, and what crosses the wire is what the contract has a schema for. Chord carries the rest — the link,
 * the principal, the addressing, the validation.
 *
 * This module is the only place the two sides share a spelling. Nothing here imports mason.
 */
import {
	type AnyContract,
	ChordError,
	type ChordErrorCode,
	hostFamily,
	hostNamed,
	method,
	type RemoteContract,
	remote,
} from "@earendil-works/chord";
import {
	arr,
	bool,
	int,
	lit,
	map,
	num,
	obj,
	opt,
	type Schema,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";

/** The major version. Two peers that disagree about it cannot talk, and Chord refuses the link rather than degrading. */
export const PROTOCOL_MAJOR = 1;

/**
 * The host names. Mason's is fixed, because a connector has to name it to reach `mason.peer`; a connector's is
 * `connector:<name>` for the name the operator configured, which is what the credential already says.
 */
export const MASON_HOST = "mason";
export const CONNECTOR_HOST_PREFIX = "connector:";

/** The contract names, spelled once. */
export const CONTRACT = { peer: "mason.peer", connector: "mason.connector" } as const;

/** The host name one connector lives at, and the one mason accepts its socket as. */
export function connectorHost(name: string): string {
	return `${CONNECTOR_HOST_PREFIX}${name}`;
}

/**
 * A send address, as the model names it: `<connector>/<target>`. The target is the operator's, out of the entry's
 * `connector.targets`; the model never sees a vendor's own chat id.
 */
export function sendAddress(connector: string, target: string): string {
	return `${connector}/${target}`;
}

/** The two halves of a send address, or `undefined` when the text is not one. */
export function parseSendAddress(text: string): { readonly connector: string; readonly target: string } | undefined {
	const at = text.indexOf("/");
	if (at <= 0 || at === text.length - 1) return undefined;
	const connector = text.slice(0, at);
	const target = text.slice(at + 1);
	if (connector.includes(" ") || target.includes(" ") || target.includes("/")) return undefined;
	return { connector, target };
}

/** The content a connector may claim it renders. A target narrows this further, because a channel may not carry files. */
export const CAPABILITIES = ["text", "markdown", "files", "approvals", "streaming"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** How an append is placed against a turn already running. */
export const SUBMISSION_MODES = ["followUp", "steer", "reject"] as const;
export type SubmissionMode = (typeof SUBMISSION_MODES)[number];

/** The controls a socket may spend, out of a closed set so a typo is refused with the whole vocabulary in the message. */
export const CONTROL_OPS = ["stop", "compact", "clear", "status"] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

/**
 * The stable error codes. A connector branches on `code` and shows `message` to a person, which is why the two are
 * separate and why the sentence may change without breaking anybody.
 */
export const ERROR_CODE = {
	faceNotGranted: "mason.face_not_granted",
	actorUnknown: "mason.actor_unknown",
	kindNotPermitted: "mason.kind_not_permitted",
	rateLimited: "mason.rate_limited",
	queueOverflow: "mason.queue_overflow",
	invalidRequest: "mason.invalid_request",
	notAuthenticated: "mason.not_authenticated",
	internal: "mason.internal",
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** How a protocol refusal reaches Chord: the fine-grained code rides in `reason`, and the context in `details`. */
export function chordCodeFor(code: ErrorCode): ChordErrorCode {
	switch (code) {
		case ERROR_CODE.invalidRequest:
			return "invalid";
		case ERROR_CODE.rateLimited:
		case ERROR_CODE.queueOverflow:
		case ERROR_CODE.internal:
			return "unavailable";
		default:
			return "forbidden";
	}
}

/**
 * Refuse a call with one of mason's codes.
 *
 * The message is the sentence a person reads; the code is what a connector branches on, and it survives the trip inside
 * the Chord error's `reason` — the one part of a Chord error that crosses a link intact.
 */
export function masonError(
	code: ErrorCode,
	message: string,
	extra: { readonly retryable?: boolean; readonly field?: string } = {},
): ChordError {
	return new ChordError(chordCodeFor(code), message, {
		reason: code,
		...(extra.retryable === undefined ? {} : { retryable: extra.retryable }),
		details: { code, message, ...extra },
	});
}

/** The protocol code a refusal carries, whichever side raised it. Chord keeps `reason` across a link; `details` it does not. */
export function errorCodeOf(error: unknown): ErrorCode | undefined {
	if (!(error instanceof ChordError)) return undefined;
	return Object.values(ERROR_CODE).includes(error.reason as ErrorCode) ? (error.reason as ErrorCode) : undefined;
}

/**
 * The key an MCP tool declares its approval marker under.
 *
 * The connector author writes it because that service knows what an operation does. Mason reads it and does not infer
 * risk from a tool's name, and it does not trust MCP's own annotations as authority: an annotation is a claim.
 */
export const APPROVAL_META_KEY = "dev.mason/approval";

/** The two markers. A tool with no marker, or one mason does not know, is `required`. */
export const APPROVAL = { required: "required", notRequired: "not_required" } as const;
export type ApprovalMarker = (typeof APPROVAL)[keyof typeof APPROVAL];

export function isApprovalMarker(value: unknown): value is ApprovalMarker {
	return value === APPROVAL.required || value === APPROVAL.notRequired;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Schemas                                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * Every object that crosses this wire is `open`, which is rule 9 of the protocol: a field a newer peer added is ignored,
 * never refused. Chord validates what the contract declares and nothing else.
 */
export const ActorSchema = obj({ id: str(), name: opt(str()) }, { open: true });
export type Actor = Static<typeof ActorSchema>;

/**
 * Where an append came from: an address this connector minted, returned to mason byte for byte and never parsed, plus
 * the medium's own id for the message when it has one.
 */
export const OriginSchema = obj({ ref: str(), messageId: opt(str()), actor: opt(ActorSchema) }, { open: true });

export const BlockSchema = union([
	obj({ type: lit("text"), text: str() }, { open: true }),
	obj({ type: lit("markdown"), text: str() }, { open: true }),
	obj({ type: lit("notice"), text: str() }, { open: true }),
	obj(
		{
			type: lit("file"),
			contentId: str(),
			name: opt(str()),
			mimeType: opt(str()),
			size: opt(num()),
			caption: opt(str()),
		},
		{ open: true },
	),
]);
export type ContentBlock = Static<typeof BlockSchema>;

/**
 * One append: the three things a connector may hand mason, and nothing else.
 *
 * A `submission` is a person's words and starts a turn. An `event` is a claim about the world, fenced as data and
 * routed to the routine its kind names. A `notice` is the medium talking about itself: it is written down and starts
 * nothing. The type is the trust boundary, which is why it is a tag on the envelope.
 */
export const AppendSchema = union([
	obj(
		{
			type: lit("submission"),
			appendId: str(),
			content: arr(BlockSchema),
			origin: opt(OriginSchema),
			mode: opt(union([lit("followUp"), lit("steer"), lit("reject")])),
			capabilities: opt(arr(str())),
		},
		{ open: true },
	),
	obj(
		{
			type: lit("event"),
			appendId: str(),
			kind: str(),
			payload: opt(unknown()),
			summary: opt(str()),
			origin: opt(OriginSchema),
		},
		{ open: true },
	),
	obj({ type: lit("notice"), appendId: str(), text: str(), origin: opt(OriginSchema) }, { open: true }),
]);
export type AppendArgs = Static<typeof AppendSchema>;

/** What came of an append. `duplicate` is mason's answer to an id it has already claimed, and it is a success. */
export const AppendResultSchema = obj({ outcome: union([lit("accepted"), lit("duplicate")]), entryId: opt(str()) });
export type AppendResult = Static<typeof AppendResultSchema>;

/**
 * One delivery, in the one direction mason initiates it.
 *
 * `target` is a target out of the entry's grant, named by the model as `<connector>/<target>`; `ref` is the opaque
 * address the connector put on the append a turn came from. Neither means the connector's own default. The id is the
 * delivery's identity for good: a connector that sees it twice has the message once.
 */
export const DeliverSchema = obj(
	{ deliveryId: str(), blocks: arr(BlockSchema), target: opt(str()), ref: opt(str()) },
	{ open: true },
);
export type DeliverArgs = Static<typeof DeliverSchema>;

/** What a connector answers a delivery with. `uncertain` exists because a lost send and a lost answer look identical. */
export const AckSchema = obj({
	status: union([lit("delivered"), lit("duplicate"), lit("uncertain"), lit("rejected")]),
	detail: opt(str()),
});
export type AckStatus = "delivered" | "duplicate" | "uncertain" | "rejected";
export type DeliveryAck = Static<typeof AckSchema>;

export const ControlSchema = obj({ op: str(), requestId: opt(str()), instructions: opt(str()) }, { open: true });
export type ControlArgs = Static<typeof ControlSchema>;

export const ControlResultSchema = obj({
	handled: bool(),
	op: str(),
	reply: opt(str()),
	status: opt(map(unknown())),
});
export type ControlResult = Static<typeof ControlResultSchema>;

/** One place this connector may be sent to, as the operator declared it, with what the channel can render. */
export const TargetSchema = obj({ id: str(), label: str(), capabilities: arr(str()) }, { open: true });
export type Target = Static<typeof TargetSchema>;

export const LimitsSchema = obj({
	submissionsPerMinute: int(),
	firesPerMinute: int(),
	controlsPerMinute: int(),
	attachmentsPerMinute: int(),
	attachmentBytes: int(),
	attachmentTtlMs: int(),
});
export type Limits = Static<typeof LimitsSchema>;

/**
 * The handshake, as state: what this connector is granted, readable as soon as its reference to `mason.peer` is ready.
 *
 * It is a state member rather than a call for one reason: a new connector cannot be told anything until it has asked,
 * and Chord's `get` already waits for a snapshot. A reconnect re-reads it, and the grant is a boot-time fact, so the
 * value cannot change under a live socket.
 */
export const SessionSchema = obj({
	protocol: int(),
	commands: arr(str()),
	targets: arr(TargetSchema),
	kinds: arr(str()),
	limits: LimitsSchema,
});
export type Session = Static<typeof SessionSchema>;

/* ---------------------------------------------------------------------------------------------------------------- */
/* The two contracts                                                                                                 */
/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * Mason's half, served at `mason`. The object is per connector: its principal is the credential's, and the `session`
 * state the factory exposes is that connector's grant and nobody else's.
 *
 * Annotated `RemoteContract` rather than left inferred: the inferred type names `MethodSpec` and the rest of the
 * contract internals, which chord does not export, so a declaration file cannot be written from it.
 */
export const MasonPeer: RemoteContract = remote(CONTRACT.peer, {
	version: 1,
	input: obj({}),
	host: hostNamed(MASON_HOST),
	variants: {
		default: {
			state: { session: SessionSchema },
			methods: {
				append: method(AppendSchema, AppendResultSchema),
				control: method(ControlSchema, ControlResultSchema),
			},
		},
	},
});

/** The connector's half, served at `connector:<name>`, one object per connector. */
export const MasonConnector: RemoteContract = remote(CONTRACT.connector, {
	version: 1,
	input: obj({ connector: str() }),
	host: hostFamily(CONNECTOR_HOST_PREFIX, "connector"),
	variants: {
		default: { methods: { deliver: method(DeliverSchema, AckSchema) } },
	},
});

/** Both, for a host that has to prove it serves what the protocol says. */
export const CONTRACTS: readonly AnyContract[] = [MasonPeer, MasonConnector];

/* ---------------------------------------------------------------------------------------------------------------- */
/* What a caller holds                                                                                               */
/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * A reference to mason's peer object, as a connector sees it.
 *
 * Written out by hand because the contract values are annotated with `RemoteContract`: chord does not export the types
 * its own inference builds, so a member lookup on a `Ref` cannot be declared from a published module. This interface is
 * the same shape the contract declares, and a test pins the two together.
 */
export interface PeerRef {
	readonly variant: "default";
	readonly session: { readonly value: Session };
	append(args: AppendArgs): Promise<AppendResult>;
	control(args: ControlArgs): Promise<ControlResult>;
}

/** A reference to one connector's object, as mason sees it. */
export interface ConnectorRef {
	readonly variant: "default";
	deliver(args: DeliverArgs): Promise<DeliveryAck>;
}

/** Where a turn came from, as the transcript holds it: the connector and the address it minted. */
export interface Origin {
	readonly connector: string;
	readonly ref: string;
	readonly messageId?: string;
	readonly actor?: Actor;
}

export interface AttachmentUploadResult {
	readonly contentId: string;
	readonly size: number;
	readonly expiresAt?: number;
}

/** The schema of one member, for a host that declares it rather than importing the contract's internals. */
export const SCHEMAS: Readonly<Record<string, Schema>> = {
	append: AppendSchema,
	deliver: DeliverSchema,
	session: SessionSchema,
};
