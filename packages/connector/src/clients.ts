/**
 * The two clients a connector can be: one that reads the conversation, and one that only appends events.
 *
 * The split is the contract's own, not a convenience. A grant with a `user` face is served `conversation` and may spend
 * controls; a grant without one gets an empty cell, no feed and no controls, and has nothing to submit. So the package
 * offers two factories over the one socket and the one credential class, and each exposes exactly what its surface has:
 * `createUserClient` submits, controls and reads; `createEventClient` appends events and reads nothing.
 *
 * `createConnector` stays internal (`./connector.ts`): it is the implementation both wrap, and the conformance kit
 * builds it directly so it can measure a fixture's behaviour rather than the wrapper's. It is not the public API — a
 * connector that wants to be a medium is one of the two clients, and a tools-only integration is an MCP server.
 */
import type { ControlResult, ConversationState, Session } from "mason-protocol";
import type { AttachmentClient, Fetcher } from "./attachments.ts";
import {
	type Connector,
	type ConnectorConfig,
	type ControlInput,
	createConnector,
	type EventInput,
	type InboundOutcome,
	type LinkFactory,
	type Logger,
	type SubmissionInput,
} from "./connector.ts";
import type { ConnectorStore } from "./store.ts";

/** What both clients are configured with: the socket, the credential, the durable store, and how a link is opened. */
export type ClientConfig = Omit<ConnectorConfig, "handlers" | "holdConversation">;

/** What a user client knows about its link: the conversation is the state it last applied. */
export interface UserClientStatus {
	readonly connected: boolean;
	readonly session: Session | undefined;
	/** The conversation as this client last applied it, snapshot and diffs included. */
	readonly conversation: ConversationState | undefined;
	readonly connections: number;
	readonly pending: number;
	readonly lastError: string | undefined;
}

/** What an event client knows about its link. It reads no conversation, so there is none to report. */
export interface EventClientStatus {
	readonly connected: boolean;
	readonly session: Session | undefined;
	readonly connections: number;
	readonly pending: number;
	readonly lastError: string | undefined;
}

/**
 * The client with the `user` grant: it appends a person's words, spends the grant's controls, and holds the conversation
 * a medium renders.
 */
export interface UserClient {
	start(): Promise<Session>;
	stop(): Promise<void>;
	status(): UserClientStatus;
	submit(input: SubmissionInput): Promise<InboundOutcome>;
	/**
	 * Raise an event. A chat both carries a person's words and reports what happened in it, so the user client keeps the
	 * event surface; the event client is the narrower one, without any of the reader's methods.
	 */
	event(input: EventInput): Promise<InboundOutcome>;
	control(input: ControlInput): Promise<ControlResult>;
	/**
	 * The conversation as the wire has it: the snapshot first, then the value each diff produced. Returns a function that
	 * removes this listener; a client may register one, and the last registration is what a render loop wants.
	 */
	onConversation(listener: (state: ConversationState) => void): () => void;
	onSession(listener: (session: Session) => void): () => void;
	onClosed(listener: (reason: string) => void): () => void;
	/** Replay the journal now, on a link that is already open. */
	flush(): Promise<void>;
	readonly attachments: AttachmentClient;
	/** Force the link down. The reconnect loop takes it from there. */
	drop(reason?: string): void;
}

/** The client without a `user` grant: it appends events and has no transcript to read. */
export interface EventClient {
	start(): Promise<Session>;
	stop(): Promise<void>;
	status(): EventClientStatus;
	event(input: EventInput): Promise<InboundOutcome>;
	onSession(listener: (session: Session) => void): () => void;
	onClosed(listener: (reason: string) => void): () => void;
	flush(): Promise<void>;
	/** Force the link down. The reconnect loop takes it from there. */
	drop(reason?: string): void;
}

/** Listeners a wrapper fans the connector's handlers out to, so registration can happen before or after `start`. */
interface Listeners<T> {
	readonly listeners: Set<(value: T) => void>;
	emit(value: T): void;
}

function listeners<T>(): Listeners<T> {
	const set = new Set<(value: T) => void>();
	return {
		listeners: set,
		emit(value) {
			for (const listener of [...set]) listener(value);
		},
	};
}

/** The config the combined factory takes: one hidden switch decides whether a conversation is held at all. */
function connectorFor(
	config: ClientConfig,
	holdConversation: boolean,
	handlers: ConnectorConfig["handlers"],
): Connector {
	return createConnector({ ...config, handlers, holdConversation });
}

export function createUserClient(config: ClientConfig): UserClient {
	const conversation = listeners<ConversationState>();
	const session = listeners<Session>();
	const closed = listeners<string>();
	const connector = connectorFor(config, true, {
		onConversation: (state) => conversation.emit(state),
		onSession: (value) => session.emit(value),
		onClosed: (reason) => closed.emit(reason),
	});
	return {
		start: () => connector.start(),
		stop: () => connector.stop(),
		status: () => connector.status(),
		submit: (input) => connector.submit(input),
		event: (input) => connector.event(input),
		control: (input) => connector.control(input),
		onConversation(listener) {
			conversation.listeners.add(listener);
			return () => conversation.listeners.delete(listener);
		},
		onSession(listener) {
			session.listeners.add(listener);
			return () => session.listeners.delete(listener);
		},
		onClosed(listener) {
			closed.listeners.add(listener);
			return () => closed.listeners.delete(listener);
		},
		flush: () => connector.flush(),
		attachments: connector.attachments,
		drop: (reason) => connector.drop(reason),
	};
}

export function createEventClient(config: ClientConfig): EventClient {
	const session = listeners<Session>();
	const closed = listeners<string>();
	// No conversation is held: the server serves an event grant an empty cell and no feed, and a client that never asks
	// for the member receives no frame of it. The surface is the grant's, and the SDK's is the same shape.
	const connector = connectorFor(config, false, {
		onSession: (value) => session.emit(value),
		onClosed: (reason) => closed.emit(reason),
	});
	return {
		start: () => connector.start(),
		stop: () => connector.stop(),
		status() {
			const status = connector.status();
			return {
				connected: status.connected,
				session: status.session,
				connections: status.connections,
				pending: status.pending,
				lastError: status.lastError,
			};
		},
		event: (input) => connector.event(input),
		onSession(listener) {
			session.listeners.add(listener);
			return () => session.listeners.delete(listener);
		},
		onClosed(listener) {
			closed.listeners.add(listener);
			return () => closed.listeners.delete(listener);
		},
		flush: () => connector.flush(),
		drop: (reason) => connector.drop(reason),
	};
}

// Re-exported so a caller can name the shapes the two factories take without importing the internal module.
export type {
	AttachmentClient,
	ControlInput,
	EventInput,
	Fetcher,
	InboundOutcome,
	LinkFactory,
	Logger,
	SubmissionInput,
};
export type { ConnectorStore };
