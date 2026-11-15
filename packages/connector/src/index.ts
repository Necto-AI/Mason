/**
 * `mason-connector` — the TypeScript SDK for one external connector.
 *
 * A connector is a Chord host that opens one socket to mason. This package owns the parts that are the same for every
 * connector and wrong in the same way when each one writes them itself: the host, the link, the durable journal, the
 * attachments and the approval marker. It does not own vendor behaviour, and it makes no policy decision: what a
 * connector may do is mason's operator's answer, not the SDK's.
 */

export type {
	Capability,
	ContentBlock,
	ControlOp,
	ControlResult,
	ErrorCode,
	IntegrationEvent,
	IntegrationManifest,
	Origin,
	Session,
} from "mason-protocol";
export {
	APPROVAL,
	APPROVAL_META_KEY,
	CAPABILITIES,
	CONTRACT,
	CONTROL_OPS,
	chordCodeFor,
	connectorHost,
	ERROR_CODE,
	errorCodeOf,
	MASON_HOST,
	MasonPeer,
	masonError,
	PROTOCOL_MAJOR,
	SUBMISSION_MODES,
} from "mason-protocol";
export {
	type AttachmentClient,
	type AttachmentClientOptions,
	AttachmentError,
	createAttachmentClient,
	type Fetcher,
} from "./attachments.ts";
export {
	type ClientConfig,
	createEventClient,
	createUserClient,
	type EventClient,
	type EventClientStatus,
	type UserClient,
	type UserClientStatus,
} from "./clients.ts";
export {
	type ControlInput,
	type EventInput,
	type InboundOutcome,
	type LinkFactory,
	type Logger,
	type SubmissionInput,
	silentLogger,
} from "./connector.ts";
export { nodeWebSocketLink, type WebSocketConstructor } from "./link.ts";
export {
	approvalMeta,
	declareTool,
	describeProblem,
	type InputSchema,
	readApprovalMarker,
	type ToolDeclaration,
} from "./mcp.ts";
export { type ConnectorStore, NAMESPACE, type StoreEntry } from "./store.ts";
