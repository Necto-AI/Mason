/**
 * `mason-connector` — the TypeScript SDK for one external connector.
 *
 * A connector is a process that may carry people's words, lend tools, and report events. This package owns the parts
 * that are the same for every connector and wrong in the same way when each one writes them itself: the socket, the
 * handshake, the durable journal, the dedup ledger, attachments, and the approval marker. It does not own vendor
 * behaviour, and it makes no policy decision: what a connector may do is mason's operator's answer, not the SDK's.
 */

export type {
	Capability,
	ContentBlock,
	ControlParams,
	ControlResult,
	DeliveryAck,
	DeliveryDeltaParams,
	DeliveryFinalParams,
	DeliveryStartParams,
	ErrorCode,
	ExternalActor,
	ExternalConversation,
	FacesDeclaration,
	HelloRequest,
	HelloResult,
	InteractionAck,
	InteractionAnswerParams,
	InteractionAnswerResult,
	InteractionRequestParams,
	Limits,
	Origin,
	ProtocolErrorData,
	StateDeltaParams,
	StateScope,
	StateSnapshotParams,
	StateSubscribeResult,
	SubmissionMode,
	SubmitParams,
} from "mason-protocol";
export {
	APPROVAL,
	APPROVAL_META_KEY,
	CAPABILITIES,
	METHOD,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	STATE_SCOPES,
} from "mason-protocol";
export {
	type AttachmentClient,
	type AttachmentClientOptions,
	AttachmentError,
	createAttachmentClient,
	type Fetcher,
} from "./attachments.ts";
export {
	type Connector,
	type ConnectorConfig,
	type ConnectorHandlers,
	type ConnectorStatus,
	createConnector,
	type FireInput,
	helloRequest,
	type InboundOutcome,
	type Logger,
	type Session,
	silentLogger,
} from "./connector.ts";
export { protocolErrorOf, protocolFailure, type RpcMessage } from "./jsonrpc.ts";
export {
	type Link,
	type LinkFactory,
	linkOver,
	linkPair,
	nodeWebSocketLink,
	type WebSocketConstructor,
	type WebSocketLike,
	webSocketLink,
} from "./link.ts";
export {
	approvalMeta,
	declareTool,
	describeProblem,
	type InputSchema,
	readApprovalMarker,
	type ToolDeclaration,
} from "./mcp.ts";
export { type ConnectorStore, LEDGER_KEEP, NAMESPACE, type StoreEntry } from "./store.ts";
export { PeerError, PeerTimeout, RpcPeer } from "./transport.ts";
