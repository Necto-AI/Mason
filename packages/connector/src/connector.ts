/**
 * The connector runtime: one socket, one durable journal, and the four acts a connector performs.
 *
 * Everything mason-specific that a connector author would otherwise get wrong lives here.
 *
 * - **Durable identity, not retries with fresh ids.** `submit` and `fire` write the call into the store before it reaches
 *   the wire, so a socket that dies mid-flight is a resend of the same id after reconnect rather than a second logical
 *   operation. Mason deduplicates on that id forever; a connector must not invent a new one for the same act.
 * - **The dedup ledger is the connector's own.** Mason resends an unacknowledged delivery under the same `deliveryId`,
 *   and the ledger is what turns that resend into `duplicate` instead of a person receiving the same message twice. It is
 *   persisted, because the restart that lost the acknowledgement is the same restart that would empty a `Map`.
 * - **A failed send is `uncertain`, not retried.** If the handler throws, nobody knows whether the vendor accepted the
 *   message. Guessing "no" duplicates it; guessing "yes" loses it. The SDK reports uncertainty and leaves the choice to a
 *   person.
 * - **Reconnect is the recovery mechanism.** There is no session resumption beyond the sequence numbers: reconnecting,
 *   replaying the journal, and re-subscribing are the whole of it.
 */
import {
	type Capability,
	type ControlParams,
	type ControlResult,
	type DeliveryAck,
	type DeliveryDeltaParams,
	type DeliveryFinalParams,
	type DeliveryStartParams,
	ERROR_CODE,
	type ErrorCode,
	type ExternalActor,
	type FacesDeclaration,
	type HelloRequest,
	type HelloResult,
	type InteractionAck,
	type InteractionAnswerParams,
	type InteractionAnswerResult,
	type InteractionRequestParams,
	isProtocolErrorData,
	type Limits,
	METHOD,
	type Origin,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	type ProtocolErrorData,
	type StateDeltaParams,
	type StateScope,
	type StateSnapshotParams,
	type StateSubscribeResult,
	type SubmitParams,
} from "mason-protocol";
import { type AttachmentClient, createAttachmentClient, type Fetcher } from "./attachments.ts";
import { protocolFailure } from "./jsonrpc.ts";
import { type Link, type LinkFactory, webSocketLink } from "./link.ts";
import { type ConnectorStore, LEDGER_KEEP, NAMESPACE } from "./store.ts";
import { PeerError, PeerTimeout, RpcPeer } from "./transport.ts";

export interface Logger {
	debug?(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

/** Discards everything. The default, because a library that logs to the console by default is a library that does. */
export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface ConnectorHandlers {
	/** A reply mason routed here. Return the ack; throw to report an uncertain vendor outcome. */
	onDelivery?(params: DeliveryFinalParams): Promise<DeliveryAck> | DeliveryAck;
	onDeliveryStart?(params: DeliveryStartParams): Promise<void> | void;
	onDeliveryDelta?(params: DeliveryDeltaParams): Promise<void> | void;
	onDeliveryCancel?(deliveryId: string, reason: string): Promise<void> | void;
	/** One paused tool call, put to a person. `delivered: false` leaves it visibly pending. */
	onInteraction?(params: InteractionRequestParams): Promise<InteractionAck> | InteractionAck;
	onState?(frame: StateSnapshotParams | StateDeltaParams): Promise<void> | void;
	/** The handshake is done, the journal is replayed. Called once per connection. */
	onSession?(session: Session): Promise<void> | void;
	/** The socket is gone and a reconnect is scheduled. */
	onClosed?(reason: string): void;
}

export interface ConnectorConfig {
	/** The connector's name as mason's operator configured it. Mason answers with its own spelling of it. */
	readonly name: string;
	readonly version: string;
	readonly url: string;
	readonly credential: string;
	readonly faces: FacesDeclaration;
	readonly store: ConnectorStore;
	readonly handlers?: ConnectorHandlers;
	readonly logger?: Logger;
	readonly now?: () => number;
	/** Substitute the socket: the conformance suite uses two ends of `linkPair()`. */
	readonly link?: LinkFactory;
	/** The state scopes this connector mirrors, re-subscribed on every reconnect. */
	readonly state?: readonly StateScope[];
	readonly reconnect?: { readonly initialMs?: number; readonly maxMs?: number; readonly factor?: number };
	readonly requestTimeoutMs?: number;
	/** How often the connector pings mason on an idle socket. 0 disables it; the protocol's number is 20 s. */
	readonly heartbeatMs?: number;
	/** Base URL for the attachment endpoints when it differs from the socket's origin. */
	readonly httpBase?: string;
	/** Substitute the transfer endpoint: the conformance suite serves attachments from memory. */
	readonly fetch?: Fetcher;
}

/** The negotiated session, and the connector's whole view of its own privilege. */
export interface Session {
	readonly connector: string;
	readonly protocol: { readonly major: number; readonly minor: number };
	readonly faces: HelloResult["faces"];
	readonly capabilities: readonly Capability[];
	/** The controls mason granted this socket on `mason/control`. Empty is no vocabulary: a word is refused. */
	readonly commands: readonly string[];
	readonly limits: Limits;
	readonly inactive: readonly { readonly face: string; readonly reason: string }[];
}

/** What came of trying to hand mason something, from the connector's side. */
export type InboundOutcome =
	| { readonly status: "accepted"; readonly id: string; readonly entryId?: string }
	| { readonly status: "duplicate"; readonly id: string; readonly entryId?: string }
	| { readonly status: "pending"; readonly id: string }
	| { readonly status: "refused"; readonly id: string; readonly error: ProtocolErrorData };

export interface ConnectorStatus {
	readonly connected: boolean;
	readonly session: Session | undefined;
	readonly connections: number;
	readonly pending: number;
	readonly lastError: string | undefined;
}

export interface FireInput {
	readonly kind: string;
	readonly payload: unknown;
	readonly fireId?: string;
	readonly origin?: Origin;
	readonly summary?: string;
}

export interface Connector {
	start(): Promise<Session>;
	stop(): Promise<void>;
	status(): ConnectorStatus;
	/** A person's words. Durable: the act survives a restart and is resent until mason claims it. */
	submit(input: Omit<SubmitParams, "submissionId"> & { readonly submissionId?: string }): Promise<InboundOutcome>;
	/** An unsolicited service event. Same durability, different act: it never creates human conversation. */
	fire(input: FireInput): Promise<InboundOutcome>;
	control(input: ControlParams): Promise<ControlResult>;
	/** Report one person's answer to one pending permission request. Applies once, and the SDK enforces the once. */
	answer(input: InteractionAnswerParams): Promise<InteractionAnswerResult>;
	subscribe(scopes: readonly StateScope[], since?: number): Promise<StateSubscribeResult>;
	/** Replay the journal now, on a socket that is already open. */
	flush(): Promise<void>;
	readonly attachments: AttachmentClient;
	/** Force the socket down, as a test or a supervisor would. The reconnect loop takes it from there. */
	drop(reason?: string): void;
}

interface OutboxEntry {
	readonly seq: number;
	readonly method: string;
	readonly key: string;
	readonly params: unknown;
}

/** What a call came to, before any method-specific shape is put on it. */
type Send<T> =
	| { readonly status: "ok"; readonly value: T }
	| { readonly status: "pending" }
	| { readonly status: "refused"; readonly error: ProtocolErrorData };

/** The id a call is journaled under, which is also the id mason deduplicates on. */
function callKey(method: string, params: Record<string, unknown>): string {
	switch (method) {
		case METHOD.submit:
			return `submit:${String(params.submissionId)}`;
		case METHOD.fire:
			return `fire:${String(params.fireId)}`;
		case METHOD.control:
			return `control:${String(params.requestId ?? "")}:${String(params.op)}`;
		case METHOD.interactionAnswer:
			return `answer:${String(params.permissionId)}`;
		default:
			return `${method}:${JSON.stringify(params)}`;
	}
}

function idOf(method: string, params: Record<string, unknown>): string {
	switch (method) {
		case METHOD.submit:
			return String(params.submissionId);
		case METHOD.fire:
			return String(params.fireId);
		case METHOD.control:
			return String(params.requestId ?? params.op);
		case METHOD.interactionAnswer:
			return String(params.permissionId);
		default:
			return "";
	}
}

export function createConnector(config: ConnectorConfig): Connector {
	const logger = config.logger ?? silentLogger;
	const now = config.now ?? Date.now;
	const linkFactory = config.link ?? webSocketLink;
	const handlers = config.handlers ?? {};
	// The cap is mason's, learnt at the handshake, so the client is built once and asks for it every time.
	let attachmentCap: number | undefined;
	const attachments = createAttachmentClient({
		baseUrl: config.httpBase ?? httpOrigin(config.url),
		credential: config.credential,
		...(config.fetch === undefined ? {} : { fetch: config.fetch }),
		maxBytes: () => attachmentCap,
	});

	const reconnect = {
		initialMs: config.reconnect?.initialMs ?? 500,
		maxMs: config.reconnect?.maxMs ?? 30_000,
		factor: config.reconnect?.factor ?? 2,
	};

	let peer: RpcPeer | undefined;
	let session: Session | undefined;
	let stopping = false;
	let connectionCount = 0;
	let lastError: string | undefined;
	let backoffMs = reconnect.initialMs;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let scopes: readonly StateScope[] = config.state ?? [];
	let flushing: Promise<void> | undefined;
	/** Seeded from the store on first use, then monotonic in memory: a read-modify-write per call hands two calls one seq. */
	let nextSeq: number | undefined;
	let seeding: Promise<void> | undefined;
	const inflight = new Map<string, Promise<Send<unknown>>>();
	const delivering = new Map<string, Promise<DeliveryAck>>();
	const asking = new Map<string, Promise<InteractionAck>>();

	const connector: Connector = {
		start,
		stop,
		status,
		submit,
		fire,
		control,
		answer,
		subscribe,
		flush: flushOutbox,
		attachments,
		drop,
	};
	return connector;

	function status(): ConnectorStatus {
		return {
			connected: peer?.open === true,
			session,
			connections: connectionCount,
			pending: inflight.size,
			lastError,
		};
	}

	async function start(): Promise<Session> {
		if (peer?.open === true && session !== undefined) return session;
		stopping = false;
		return connect();
	}

	async function stop(): Promise<void> {
		stopping = true;
		if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
		if (flushTimer !== undefined) clearTimeout(flushTimer);
		if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
		reconnectTimer = undefined;
		flushTimer = undefined;
		heartbeatTimer = undefined;
		peer?.close("the connector is shutting down");
		peer = undefined;
		await config.store.close();
	}

	function drop(reason = "dropped"): void {
		peer?.close(reason);
	}

	async function connect(): Promise<Session> {
		const link: Link = linkFactory(config.url, { credential: config.credential });
		const next = new RpcPeer(
			link,
			{
				request: (method, params) => onRequest(method, params),
				notification: (method, params) => onNotification(method, params),
				closed: (reason) => onClosed(reason),
			},
			{ timeoutMs: config.requestTimeoutMs ?? 30_000 },
		);
		peer = next;
		connectionCount += 1;

		let answer: HelloResult;
		try {
			answer = (await next.call(METHOD.hello, helloRequest(config))) as HelloResult;
		} catch (error) {
			lastError = describe(error);
			next.close("the handshake failed");
			throw error;
		}

		session = {
			connector: answer.connector,
			protocol: { major: answer.protocol.major, minor: answer.protocol.minors?.[0] ?? PROTOCOL_MINOR },
			faces: answer.faces,
			capabilities: answer.capabilities,
			commands: answer.commands ?? [],
			limits: answer.limits,
			inactive: answer.inactive ?? [],
		};
		backoffMs = reconnect.initialMs;
		lastError = undefined;
		attachmentCap = answer.limits.attachmentBytes;
		startHeartbeat();

		if (scopes.length > 0) {
			try {
				await subscribe(scopes, await config.store.read<number>(NAMESPACE.state, "seq"));
			} catch (error) {
				logger.warn("the state subscription was refused", { error: describe(error) });
			}
		}

		await flushOutbox();
		try {
			await handlers.onSession?.(session);
		} catch (error) {
			logger.error("onSession threw", { error: describe(error) });
		}
		return session;
	}

	function onClosed(reason: string): void {
		const wasOpen = peer !== undefined;
		peer = undefined;
		if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		if (!wasOpen) return;
		lastError = reason;
		try {
			handlers.onClosed?.(reason);
		} catch (error) {
			logger.error("onClosed threw", { error: describe(error) });
		}
		if (stopping) return;
		scheduleReconnect();
	}

	function scheduleReconnect(): void {
		if (reconnectTimer !== undefined || stopping) return;
		const wait = backoffMs;
		backoffMs = Math.min(backoffMs * reconnect.factor, reconnect.maxMs);
		logger.info("reconnecting", { inMs: wait });
		const timer = setTimeout(() => {
			reconnectTimer = undefined;
			void connect().catch((error: unknown) => {
				lastError = describe(error);
				logger.warn("reconnect failed", { error: lastError });
				scheduleReconnect();
			});
		}, wait);
		timer.unref?.();
		reconnectTimer = timer;
	}

	async function onRequest(method: string, params: unknown): Promise<unknown> {
		switch (method) {
			case METHOD.ping:
				return { at: now() };
			case METHOD.deliveryFinal:
				return settleDelivery(asParams<DeliveryFinalParams>(params));
			case METHOD.interactionRequest:
				return putInteraction(asParams<InteractionRequestParams>(params));
			default:
				throw new PeerError(method, -32601, `${method} is not a method this connector answers`, {
					code: ERROR_CODE.invalidRequest,
					message: `${method} is not a method this connector answers`,
				});
		}
	}

	async function onNotification(method: string, params: unknown): Promise<void> {
		switch (method) {
			case METHOD.deliveryStart:
				await handlers.onDeliveryStart?.(asParams<DeliveryStartParams>(params));
				return;
			case METHOD.deliveryDelta:
				await handlers.onDeliveryDelta?.(asParams<DeliveryDeltaParams>(params));
				return;
			case METHOD.deliveryCancel: {
				const record = asParams<{ deliveryId?: unknown; reason?: unknown }>(params);
				await handlers.onDeliveryCancel?.(String(record.deliveryId), String(record.reason ?? "cancelled"));
				return;
			}
			case METHOD.stateSnapshot:
			case METHOD.stateDelta: {
				const frame = asParams<StateSnapshotParams | StateDeltaParams>(params);
				await noteSeq(frame);
				await handlers.onState?.(frame);
				return;
			}
			default:
				logger.debug?.("ignored a notification this connector does not implement", { method });
		}
	}

	/**
	 * Answer one delivery exactly once.
	 *
	 * Both guards are needed and they catch different things. The in-memory map catches two frames for one id that
	 * overlap on a live socket — mason's own request timing out while the handler is still sending is the ordinary way
	 * that happens. The ledger catches the same frame arriving again after a reconnect or a restart, which is the case
	 * the whole at-least-once arrangement is built around.
	 *
	 * Every answer is remembered, including `uncertain` and `rejected`: a send that *may* have left must not be
	 * attempted a second time when its answer was lost, because that is precisely the duplicate the ledger exists to
	 * prevent.
	 */
	async function settleDelivery(params: DeliveryFinalParams): Promise<DeliveryAck> {
		const running = delivering.get(params.deliveryId);
		if (running !== undefined) return running;
		const settled = settleOnce(params).finally(() => delivering.delete(params.deliveryId));
		delivering.set(params.deliveryId, settled);
		return settled;
	}

	async function settleOnce(params: DeliveryFinalParams): Promise<DeliveryAck> {
		const seen = await config.store.read<DeliveryAck>(NAMESPACE.delivered, params.deliveryId);
		if (seen !== undefined) {
			// A resent `delivered` is a duplicate; a resent `uncertain` is still uncertain, and saying so again is what
			// keeps mason from recording a delivery it never got.
			return seen.status === "delivered" || seen.status === "duplicate"
				? { status: "duplicate", detail: `already settled as ${seen.status}` }
				: seen;
		}
		if (handlers.onDelivery === undefined) {
			return { status: "rejected", detail: "this connector implements no delivery face" };
		}
		let ack: DeliveryAck;
		try {
			ack = await handlers.onDelivery(params);
		} catch (error) {
			ack = { status: "uncertain", detail: `the send failed after it may have left: ${describe(error)}` };
		}
		await config.store.write(NAMESPACE.delivered, params.deliveryId, ack);
		await config.store.prune(NAMESPACE.delivered, LEDGER_KEEP);
		return ack;
	}

	async function putInteraction(params: InteractionRequestParams): Promise<InteractionAck> {
		const settled = await config.store.read<{ answer: string }>(NAMESPACE.settled, params.permissionId);
		if (settled !== undefined) return { delivered: false, detail: "this request was already settled" };
		const running = asking.get(params.permissionId);
		if (running !== undefined) return running;
		const asked = ask(params).finally(() => asking.delete(params.permissionId));
		asking.set(params.permissionId, asked);
		return asked;
	}

	async function ask(params: InteractionRequestParams): Promise<InteractionAck> {
		if (handlers.onInteraction === undefined) return { delivered: false, detail: "there is nowhere to ask" };
		try {
			return await handlers.onInteraction(params);
		} catch (error) {
			return { delivered: false, detail: describe(error) };
		}
	}

	/**
	 * Ping on an idle socket, and use the tick to retry what is journaled. A connector that only resent on reconnect
	 * would leave a call refused for budget waiting for an unrelated network event that may never come.
	 */
	function startHeartbeat(): void {
		if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		const every = config.heartbeatMs ?? 20_000;
		if (every <= 0) return;
		const timer = setInterval(() => {
			void beat().catch((error: unknown) => {
				logger.error("the heartbeat threw", { error: describe(error) });
			});
		}, every);
		timer.unref?.();
		heartbeatTimer = timer;
	}

	async function beat(): Promise<void> {
		if (peer === undefined || !peer.open) return;
		try {
			await peer.call(METHOD.ping, { at: now() }, { timeoutMs: 5_000 });
		} catch (error) {
			logger.debug?.("the heartbeat was not answered", { error: describe(error) });
		}
		await flushOutbox();
	}

	/** Retry what was refused for budget after exactly the wait mason asked for, once. */
	function scheduleFlush(inMs: number): void {
		if (flushTimer !== undefined || stopping) return;
		const wait = Math.min(Math.max(inMs, 10), 60_000);
		const timer = setTimeout(() => {
			flushTimer = undefined;
			void flushOutbox().catch((error: unknown) => {
				logger.error("the retry threw", { error: describe(error) });
			});
		}, wait);
		timer.unref?.();
		flushTimer = timer;
	}

	async function noteSeq(frame: StateSnapshotParams | StateDeltaParams): Promise<void> {
		const current = await config.store.read<number>(NAMESPACE.state, "seq");
		if (current !== undefined && frame.seq <= current) return;
		await config.store.write(NAMESPACE.state, "seq", frame.seq);
	}

	async function subscribe(next: readonly StateScope[], since?: number): Promise<StateSubscribeResult> {
		if (peer === undefined) throw new Error("there is no socket to subscribe on");
		const params = since === undefined ? { scopes: next } : { scopes: next, since };
		const result = (await peer.call(METHOD.stateSubscribe, params)) as StateSubscribeResult;
		// Only now: a refused scope must not become the set every later reconnect asks for, which would leave the
		// connector mirroring nothing at all and saying nothing about it.
		scopes = next;
		return result;
	}

	function submit(
		input: Omit<SubmitParams, "submissionId"> & { readonly submissionId?: string },
	): Promise<InboundOutcome> {
		const params = { ...input, submissionId: input.submissionId ?? mintId("sub", now) };
		return inbound(METHOD.submit, params as unknown as Record<string, unknown>);
	}

	function fire(input: FireInput): Promise<InboundOutcome> {
		const params = {
			fireId: input.fireId ?? mintId("fire", now),
			kind: input.kind,
			payload: input.payload,
			...(input.origin === undefined ? {} : { origin: input.origin }),
			...(input.summary === undefined ? {} : { summary: input.summary }),
		};
		return inbound(METHOD.fire, params as unknown as Record<string, unknown>);
	}

	async function inbound(method: string, params: Record<string, unknown>): Promise<InboundOutcome> {
		const id = idOf(method, params);
		const outcome = await send(method, params);
		if (outcome.status === "pending") return { status: "pending", id };
		if (outcome.status === "refused") return { status: "refused", id, error: outcome.error };
		const record = outcome.value as Record<string, unknown>;
		const entryId = typeof record.entryId === "string" ? record.entryId : undefined;
		if (record.accepted !== true) {
			return {
				status: "refused",
				id,
				error: { code: ERROR_CODE.internal, message: "mason did not accept the call" },
			};
		}
		const claimed = typeof record.id === "string" && record.id.length > 0 ? record.id : id;
		return record.duplicate === true
			? { status: "duplicate", id: claimed, ...(entryId === undefined ? {} : { entryId }) }
			: { status: "accepted", id: claimed, ...(entryId === undefined ? {} : { entryId }) };
	}

	async function control(input: ControlParams): Promise<ControlResult> {
		const params = { requestId: mintId("ctl", now), ...input };
		const outcome = await send(METHOD.control, params as unknown as Record<string, unknown>);
		if (outcome.status === "refused") return { handled: false, op: input.op, reply: outcome.error.message };
		if (outcome.status === "pending") {
			return {
				handled: false,
				op: input.op,
				reply: "not sent yet: mason is unreachable, and the request is queued",
			};
		}
		return outcome.value as ControlResult;
	}

	async function answer(input: InteractionAnswerParams): Promise<InteractionAnswerResult> {
		const settled = await config.store.read<{ answer: string }>(NAMESPACE.settled, input.permissionId);
		if (settled !== undefined) return { settled: false, reason: "this request was already answered" };
		const outcome = await send(METHOD.interactionAnswer, input as unknown as Record<string, unknown>);
		if (outcome.status === "refused") return { settled: false, reason: outcome.error.message };
		if (outcome.status === "pending") {
			return { settled: false, reason: "not sent yet: mason is unreachable, and the answer is queued" };
		}
		const result = outcome.value as InteractionAnswerResult;
		if (result.settled) await config.store.write(NAMESPACE.settled, input.permissionId, { answer: input.answer });
		return result;
	}

	/** One durable call: journaled, sent if a socket is open, retried on reconnect, and deduplicated in-process. */
	function send(method: string, params: Record<string, unknown>): Promise<Send<unknown>> {
		const key = callKey(method, params);
		const running = inflight.get(key);
		if (running !== undefined) return running;
		const promise = runOnce(method, key, params).finally(() => inflight.delete(key));
		inflight.set(key, promise);
		return promise;
	}

	async function runOnce(method: string, key: string, params: Record<string, unknown>): Promise<Send<unknown>> {
		await journal(method, key, params);
		if (peer === undefined || !peer.open) return { status: "pending" };
		return deliver(method, key, params);
	}

	async function deliver(method: string, key: string, params: Record<string, unknown>): Promise<Send<unknown>> {
		if (peer === undefined || !peer.open) return { status: "pending" };
		try {
			const value = await peer.call(method, params);
			await config.store.delete(NAMESPACE.outbox, key);
			return { status: "ok", value };
		} catch (error) {
			if (error instanceof PeerError) {
				if (error.retryable) {
					scheduleFlush(error.retryAfterMs ?? reconnect.initialMs);
					return { status: "pending" };
				}
				await config.store.delete(NAMESPACE.outbox, key);
				return { status: "refused", error: error.data ?? { code: ERROR_CODE.internal, message: error.message } };
			}
			if (error instanceof PeerTimeout) return { status: "pending" };
			return { status: "pending" };
		}
	}

	/**
	 * Read the highest sequence the store already holds, once, behind one promise.
	 *
	 * Two calls that arrive together both see an empty journal; seeding inside the same await is what keeps them from
	 * both writing `seq: 1`, and the increment below is synchronous, so one of them takes the next number.
	 */
	async function seedSeq(): Promise<void> {
		if (nextSeq !== undefined) return;
		seeding ??= (async () => {
			const all = await config.store.entries<OutboxEntry>(NAMESPACE.outbox);
			nextSeq = Math.max(
				nextSeq ?? 0,
				all.reduce((highest, entry) => Math.max(highest, entry.value.seq), 0),
			);
		})();
		await seeding;
	}

	/** Write the call down before it goes on the wire. Undone only by a claim or a final refusal. */
	async function journal(method: string, key: string, params: Record<string, unknown>): Promise<void> {
		const existing = await config.store.read<OutboxEntry>(NAMESPACE.outbox, key);
		if (existing !== undefined) return;
		await seedSeq();
		nextSeq = (nextSeq ?? 0) + 1;
		await config.store.write(NAMESPACE.outbox, key, { seq: nextSeq, method, key, params } satisfies OutboxEntry);
	}

	/**
	 * Replay what was journaled and never claimed, in the order it happened.
	 *
	 * A call still waiting stops its own class and no other: a submission held for budget must not reorder the person's
	 * messages against each other, and must not keep a `stop` behind it.
	 */
	async function flushOutbox(): Promise<void> {
		if (flushing !== undefined) return flushing;
		const running = drainOutbox().finally(() => {
			flushing = undefined;
		});
		flushing = running;
		return running;
	}

	async function drainOutbox(): Promise<void> {
		if (peer === undefined || !peer.open) return;
		const pending = await config.store.entries<OutboxEntry>(NAMESPACE.outbox);
		const ordered = [...pending].sort((left, right) => left.value.seq - right.value.seq);
		const stalled = new Set<string>();
		for (const entry of ordered) {
			const { method, params } = entry.value;
			if (stalled.has(method)) continue;
			// Through `send`, so a call already in flight from a direct call shares its promise instead of going twice.
			const outcome = await send(method, params as Record<string, unknown>);
			if (outcome.status === "pending") {
				stalled.add(method);
				continue;
			}
			if (outcome.status === "refused") {
				logger.warn("a journaled call was refused for good", { method, detail: outcome.error.message });
				continue;
			}
			logger.info("replayed a journaled call", { method, id: idOf(method, params as Record<string, unknown>) });
		}
	}
}

/** A stable id this connector mints for one act. Monotonic enough to sort, unique enough to deduplicate. */
function mintId(prefix: string, now: () => number): string {
	return `${prefix}-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function asParams<T>(params: unknown): T {
	if (typeof params !== "object" || params === null) {
		throw new PeerError("<inbound>", -32602, "this method needs an object", {
			code: ERROR_CODE.invalidRequest,
			message: "this method needs an object",
		});
	}
	return params as T;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function httpOrigin(url: string): string {
	const parsed = new URL(url);
	return `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`;
}

/** The hello frame a connector sends, built here so two connectors cannot disagree about what one looks like. */
export function helloRequest(config: {
	readonly name: string;
	readonly version: string;
	readonly faces: FacesDeclaration;
}): HelloRequest {
	return {
		protocol: { major: PROTOCOL_MAJOR, minors: [PROTOCOL_MINOR] },
		connector: { name: config.name, version: config.version },
		faces: config.faces,
	};
}

export type { Capability, ErrorCode, ExternalActor, FacesDeclaration, Limits, Origin, ProtocolErrorData, StateScope };
export { protocolFailure, isProtocolErrorData };
