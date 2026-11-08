/**
 * The connector runtime: one Chord host, one durable journal, and the three acts a connector performs.
 *
 * Everything here is the part a connector author would otherwise get wrong:
 *
 * - **Durable identity, not retries with fresh ids.** `append` and `control` write the call into the store before it
 *   reaches the link, so a link that dies mid-flight is a resend of the same id after reconnect rather than a second
 *   logical operation. Mason deduplicates on that id forever; a connector must not invent a new one for the same act.
 * - **The delivery ledger is the connector's own.** Mason resends an unacknowledged delivery under the same
 *   `deliveryId`, and the ledger is what turns that resend into `duplicate` instead of a person receiving the same
 *   message twice. It is persisted, because the restart that lost the acknowledgement is the same restart that would
 *   empty a `Map`.
 * - **A failed send is `uncertain`, not retried.** If the handler throws, nobody knows whether the vendor accepted the
 *   message. Guessing "no" duplicates it; guessing "yes" loses it. The SDK reports uncertainty and leaves the choice to
 *   a person.
 * - **Reconnect is the recovery mechanism.** The host keeps one link to mason; a new link re-holds every reference, and
 *   the journal is replayed over it.
 */
import { createHost, type Host, type Link } from "@earendil-works/chord";
import {
	type ContentBlock,
	type ControlOp,
	type ControlResult,
	connectorHost,
	type DeliverArgs,
	type DeliveryAck,
	ERROR_CODE,
	errorCodeOf,
	MasonConnector,
	MasonPeer,
	type PeerRef,
	type Session,
} from "mason-protocol";
import { type AttachmentClient, createAttachmentClient, type Fetcher } from "./attachments.ts";
import { type ConnectorStore, LEDGER_KEEP, NAMESPACE } from "./store.ts";

export interface Logger {
	debug?(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

/** Discards everything. The default, because a library that logs to the console by default is a library that does. */
export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** What mason sends a connector: one delivery, and the address it is for. */
export interface Delivery {
	readonly deliveryId: string;
	readonly blocks: readonly ContentBlock[];
	/** A target out of mason's grant, for a message the model addressed. */
	readonly target?: string;
	/** The opaque address this connector minted on the append the turn came from. */
	readonly ref?: string;
}

export interface ConnectorHandlers {
	/** One message mason routed here. Return the ack; throw to report an uncertain vendor outcome. */
	onDelivery(delivery: Delivery): Promise<DeliveryAck> | DeliveryAck;
	/** The session is live and the journal has been replayed. Called once per connection. */
	onSession?(session: Session): Promise<void> | void;
	/** The link is gone and a reconnect is scheduled. */
	onClosed?(reason: string): void;
}

export interface ConnectorConfig {
	/** The connector's name as mason's operator configured it. Mason's credential speaks for it and nothing else. */
	readonly name: string;
	readonly version: string;
	readonly url: string;
	readonly credential: string;
	readonly store: ConnectorStore;
	readonly handlers?: ConnectorHandlers;
	readonly logger?: Logger;
	readonly now?: () => number;
	/** How a link to mason is opened. `nodeWebSocketLink(WebSocket)` is the Node one; a test supplies a pair. */
	readonly link: LinkFactory;
	readonly reconnect?: { readonly initialMs?: number; readonly maxMs?: number; readonly factor?: number };
	/** How long `start` waits for mason to answer before it fails: the first connection only. Default 5 s. */
	readonly firstConnectionMs?: number;
	/** Base URL for the attachment endpoints when it differs from the socket's origin. */
	readonly httpBase?: string;
	/** Substitute the transfer endpoint: the conformance suite serves attachments from memory. */
	readonly fetch?: Fetcher;
	/** How long a call to mason may take before it is left journaled. Chord's own default is 60 s. */
	readonly readyTimeout?: number;
}

/** How a Chord link is opened for one connection: `webSocketLink` in production, a pair of memory links in a test. */
export type LinkFactory = (url: string, init: { readonly credential: string }) => Link;

/** What came of trying to hand mason something, from the connector's side. */
export type InboundOutcome =
	| { readonly status: "accepted"; readonly id: string; readonly entryId?: string }
	| { readonly status: "duplicate"; readonly id: string; readonly entryId?: string }
	| { readonly status: "pending"; readonly id: string }
	| { readonly status: "refused"; readonly id: string; readonly code: string; readonly reason: string };

export interface ConnectorStatus {
	readonly connected: boolean;
	readonly session: Session | undefined;
	readonly connections: number;
	readonly pending: number;
	readonly lastError: string | undefined;
}

/** A person's words, on their way to mason. Durable: the act survives a restart and is resent until mason claims it. */
export interface SubmissionInput {
	readonly content: readonly ContentBlock[];
	readonly origin?: {
		readonly ref: string;
		readonly messageId?: string;
		readonly actor?: { id: string; name?: string };
	};
	readonly mode?: "followUp" | "steer" | "reject";
	readonly capabilities?: readonly string[];
	readonly appendId?: string;
}

/** An unsolicited service event. Same durability, different act: it never becomes a person's conversation. */
export interface EventInput {
	readonly kind: string;
	readonly payload?: unknown;
	readonly summary?: string;
	readonly origin?: { readonly ref: string; readonly messageId?: string };
	readonly appendId?: string;
}

/** The medium talking about itself: written down, and it starts nothing. */
export interface NoticeInput {
	readonly text: string;
	readonly origin?: { readonly ref: string; readonly messageId?: string };
	readonly appendId?: string;
}

export interface ControlInput {
	readonly op: ControlOp;
	readonly instructions?: string;
	readonly requestId?: string;
}

export interface Connector {
	start(): Promise<Session>;
	stop(): Promise<void>;
	status(): ConnectorStatus;
	submit(input: SubmissionInput): Promise<InboundOutcome>;
	event(input: EventInput): Promise<InboundOutcome>;
	notice(input: NoticeInput): Promise<InboundOutcome>;
	control(input: ControlInput): Promise<ControlResult>;
	/** Replay the journal now, on a link that is already open. */
	flush(): Promise<void>;
	readonly attachments: AttachmentClient;
	/** Force the link down, as a test or a supervisor would. The reconnect loop takes it from there. */
	drop(reason?: string): void;
}

/** One journaled call: what to send, and the id it is deduplicated by on both sides. */
interface Journaled {
	readonly seq: number;
	readonly id: string;
	readonly kind: "append" | "control";
	readonly args: Record<string, unknown>;
}

/** What a call came to, before the caller's own shape is put on it. */
type Sent<T> =
	| { readonly status: "ok"; readonly value: T }
	| { readonly status: "pending" }
	| { readonly status: "refused"; readonly code: string; readonly reason: string };

export function createConnector(config: ConnectorConfig): Connector {
	const logger = config.logger ?? silentLogger;
	const now = config.now ?? Date.now;
	const handlers = config.handlers ?? { onDelivery: () => ({ status: "rejected", detail: "no delivery face" }) };
	const principal = { connector: config.name };
	const host: Host<{ connector: string }> = createHost({
		name: connectorHost(config.name),
		self: principal,
		...(config.readyTimeout === undefined ? {} : { readyTimeout: config.readyTimeout }),
		onError: (error) => logger.error("the connector host failed", { error: describe(error) }),
	});

	let cap: number | undefined;
	const attachments = createAttachmentClient({
		baseUrl: config.httpBase ?? httpOrigin(config.url),
		credential: config.credential,
		...(config.fetch === undefined ? {} : { fetch: config.fetch }),
		maxBytes: () => cap,
	});

	host.serve(MasonConnector, () => ({
		variant: "default",
		deliver: (args: DeliverArgs) => settle(args),
	}));

	const reconnect = {
		initialMs: config.reconnect?.initialMs ?? 500,
		maxMs: config.reconnect?.maxMs ?? 30_000,
		factor: config.reconnect?.factor ?? 2,
	};

	let peer: PeerRef | undefined;
	/** The link this connection runs on, so `drop` ends the link rather than the host it lives in. */
	let currentLink: Link | undefined;
	let session: Session | undefined;
	let stopping = false;
	let connections = 0;
	let lastError: string | undefined;
	let backoffMs = reconnect.initialMs;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let flushing: Promise<void> | undefined;
	/** Seeded from the store on first use, then monotonic in memory: a read-modify-write per call hands two calls one seq. */
	let nextSeq: number | undefined;
	let seeding: Promise<void> | undefined;
	const inflight = new Map<string, Promise<Sent<unknown>>>();
	const delivering = new Map<string, Promise<DeliveryAck>>();

	const connector: Connector = {
		start,
		stop,
		status,
		submit,
		event,
		notice,
		control,
		flush,
		attachments,
		drop,
	};
	return connector;

	function status(): ConnectorStatus {
		return {
			connected: peer !== undefined,
			session,
			connections,
			pending: inflight.size,
			lastError,
		};
	}

	async function start(): Promise<Session> {
		if (session !== undefined && peer !== undefined) return session;
		stopping = false;
		// The first connection is the only one with a deadline: it answers "is mason there", where a later drop has a
		// session to come back to and a loop that is already retrying. A url nobody answers is a sentence, not a hang.
		const wait = config.firstConnectionMs ?? 5_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				lastError = `no answer within ${wait} ms`;
				currentLink?.close(lastError);
				reject(new Error(lastError));
			}, wait);
		});
		try {
			return await Promise.race([connect(), deadline]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	async function stop(): Promise<void> {
		stopping = true;
		if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
		if (flushTimer !== undefined) clearTimeout(flushTimer);
		reconnectTimer = undefined;
		flushTimer = undefined;
		peer = undefined;
		await host.close();
		await config.store.close();
	}

	/**
	 * Force the link down, the way a supervisor or a test would.
	 *
	 * The link, not the host: a closed host is a host that never comes back, and the point of a drop is that the
	 * reconnect loop handles it. The next connection opens a new link and accepts the new upstream.
	 */
	function drop(reason = "dropped"): void {
		const link = currentLink;
		if (link === undefined) return;
		lastError = reason;
		link.close(reason);
	}

	/**
	 * Open one link, and wait for the handshake to be readable.
	 *
	 * Chord's `get` waits for the snapshot, so the session is the handshake: the connector learns its targets, its
	 * control vocabulary and its budgets from the object's state, and there is no separate hello to answer.
	 */
	async function connect(): Promise<Session> {
		const link = config.link(config.url, { credential: config.credential });
		connections += 1;
		currentLink = link;
		link.onClose((reason) => onClosed(reason));
		host.connect(link, { principal });
		let held: PeerRef;
		try {
			held = (await host.get(MasonPeer, {})) as unknown as PeerRef;
		} catch (error) {
			// The first connection says whether mason is there at all. A refusal here is the answer a command prints, not
			// something to retry in the dark: a supervisor restarts a process, and a person reads a sentence.
			lastError = describe(error);
			link.close(lastError);
			throw error;
		}
		const state = held.session.value;
		peer = held;
		session = state;
		cap = state.limits.attachmentBytes;
		backoffMs = reconnect.initialMs;
		lastError = undefined;
		await flush();
		try {
			await handlers.onSession?.(state);
		} catch (error) {
			logger.error("onSession threw", { error: describe(error) });
		}
		return state;
	}

	function onClosed(reason: string): void {
		if (peer === undefined) return;
		peer = undefined;
		currentLink = undefined;
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

	/**
	 * Answer one delivery exactly once.
	 *
	 * Both guards are needed and they catch different things. The in-memory map catches two calls for one id that
	 * overlap on a live link. The ledger catches the same delivery arriving again after a reconnect or a restart, which
	 * is the case the whole at-least-once arrangement is built around.
	 *
	 * Every answer is remembered, including `uncertain` and `rejected`: a send that *may* have left must not be
	 * attempted a second time when its answer was lost, because that is precisely the duplicate the ledger prevents.
	 */
	function settle(delivery: Delivery): Promise<DeliveryAck> {
		const running = delivering.get(delivery.deliveryId);
		if (running !== undefined) return running;
		const settled = settleOnce(delivery).finally(() => delivering.delete(delivery.deliveryId));
		delivering.set(delivery.deliveryId, settled);
		return settled;
	}

	async function settleOnce(delivery: Delivery): Promise<DeliveryAck> {
		const seen = await config.store.read<DeliveryAck>(NAMESPACE.delivered, delivery.deliveryId);
		if (seen !== undefined) {
			// A resent `delivered` is a duplicate; a resent `uncertain` is still uncertain, and saying so again is what
			// keeps mason from recording a delivery it never got.
			return seen.status === "delivered" || seen.status === "duplicate"
				? { status: "duplicate", detail: `already settled as ${seen.status}` }
				: seen;
		}
		let ack: DeliveryAck;
		try {
			ack = await handlers.onDelivery(delivery);
		} catch (error) {
			ack = { status: "uncertain", detail: `the send failed after it may have left: ${describe(error)}` };
		}
		await config.store.write(NAMESPACE.delivered, delivery.deliveryId, ack);
		await config.store.prune(NAMESPACE.delivered, LEDGER_KEEP);
		return ack;
	}

	function submit(input: SubmissionInput): Promise<InboundOutcome> {
		const appendId = input.appendId ?? mintId("sub", now);
		return inbound(appendId, {
			type: "submission",
			appendId,
			content: input.content,
			...(input.origin === undefined ? {} : { origin: input.origin }),
			...(input.mode === undefined ? {} : { mode: input.mode }),
			...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
		});
	}

	function event(input: EventInput): Promise<InboundOutcome> {
		const appendId = input.appendId ?? mintId("evt", now);
		return inbound(appendId, {
			type: "event",
			appendId,
			kind: input.kind,
			...(input.payload === undefined ? {} : { payload: input.payload }),
			...(input.summary === undefined ? {} : { summary: input.summary }),
			...(input.origin === undefined ? {} : { origin: input.origin }),
		});
	}

	function notice(input: NoticeInput): Promise<InboundOutcome> {
		const appendId = input.appendId ?? mintId("note", now);
		return inbound(appendId, {
			type: "notice",
			appendId,
			text: input.text,
			...(input.origin === undefined ? {} : { origin: input.origin }),
		});
	}

	async function inbound(appendId: string, args: Record<string, unknown>): Promise<InboundOutcome> {
		const outcome = await send("append", appendId, args);
		if (outcome.status === "pending") return { status: "pending", id: appendId };
		if (outcome.status === "refused") {
			return { status: "refused", id: appendId, code: outcome.code, reason: outcome.reason };
		}
		const record = outcome.value as { outcome: "accepted" | "duplicate"; entryId?: string };
		return record.outcome === "duplicate"
			? { status: "duplicate", id: appendId, ...(record.entryId === undefined ? {} : { entryId: record.entryId }) }
			: { status: "accepted", id: appendId, ...(record.entryId === undefined ? {} : { entryId: record.entryId }) };
	}

	async function control(input: ControlInput): Promise<ControlResult> {
		const requestId = input.requestId ?? mintId("ctl", now);
		const args = {
			op: input.op,
			requestId,
			...(input.instructions === undefined ? {} : { instructions: input.instructions }),
		};
		const outcome = await send("control", requestId, args);
		if (outcome.status === "refused") return { handled: false, op: input.op, reply: outcome.reason };
		if (outcome.status === "pending") {
			return {
				handled: false,
				op: input.op,
				reply: "not sent yet: mason is unreachable, and the request is queued",
			};
		}
		return outcome.value as ControlResult;
	}

	/** One durable call: journaled, sent if a link is open, retried on reconnect, and deduplicated in-process. */
	function send(kind: Journaled["kind"], id: string, args: Record<string, unknown>): Promise<Sent<unknown>> {
		const key = `${kind}:${id}`;
		const running = inflight.get(key);
		if (running !== undefined) return running;
		const promise = runOnce(kind, id, key, args).finally(() => inflight.delete(key));
		inflight.set(key, promise);
		return promise;
	}

	async function runOnce(
		kind: Journaled["kind"],
		id: string,
		key: string,
		args: Record<string, unknown>,
	): Promise<Sent<unknown>> {
		await journal(kind, id, key, args);
		if (peer === undefined) return { status: "pending" };
		return deliverCall(kind, key, args);
	}

	async function deliverCall(
		kind: Journaled["kind"],
		key: string,
		args: Record<string, unknown>,
	): Promise<Sent<unknown>> {
		if (peer === undefined) return { status: "pending" };
		try {
			const value = kind === "append" ? await peer.append(args as never) : await peer.control(args as never);
			await config.store.delete(NAMESPACE.outbox, key);
			return { status: "ok", value };
		} catch (error) {
			const code = errorCodeOf(error);
			// A caller that could not have been heard is not a verdict: Chord says `unavailable` for a link that is going
			// down, for a budget, and for a call the far end refused to run. All three are worth another try.
			if (code === ERROR_CODE.internal || code === ERROR_CODE.rateLimited || code === ERROR_CODE.queueOverflow) {
				scheduleFlush(reconnect.initialMs);
				return { status: "pending" };
			}
			if (code === undefined) {
				// No protocol code: the link, not mason, refused the call. Keep it journaled.
				peer = undefined;
				scheduleReconnect();
				return { status: "pending" };
			}
			await config.store.delete(NAMESPACE.outbox, key);
			return { status: "refused", code, reason: describe(error) };
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
			const all = await config.store.entries<Journaled>(NAMESPACE.outbox);
			nextSeq = Math.max(
				nextSeq ?? 0,
				all.reduce((highest, entry) => Math.max(highest, entry.value.seq), 0),
			);
		})();
		await seeding;
	}

	/** Write the call down before it goes on the link. Undone only by a claim or a final refusal. */
	async function journal(
		kind: Journaled["kind"],
		id: string,
		key: string,
		args: Record<string, unknown>,
	): Promise<void> {
		const existing = await config.store.read<Journaled>(NAMESPACE.outbox, key);
		if (existing !== undefined) return;
		await seedSeq();
		nextSeq = (nextSeq ?? 0) + 1;
		await config.store.write(NAMESPACE.outbox, key, {
			seq: nextSeq,
			id,
			kind,
			args,
		} satisfies Journaled);
	}

	/** Retry what was refused, after exactly one backoff step. */
	function scheduleFlush(inMs: number): void {
		if (flushTimer !== undefined || stopping) return;
		const wait = Math.min(Math.max(inMs, 10), 60_000);
		const timer = setTimeout(() => {
			flushTimer = undefined;
			void flush().catch((error: unknown) => {
				logger.error("the retry threw", { error: describe(error) });
			});
		}, wait);
		timer.unref?.();
		flushTimer = timer;
	}

	async function flush(): Promise<void> {
		if (flushing !== undefined) return flushing;
		const running = drain().finally(() => {
			flushing = undefined;
		});
		flushing = running;
		return running;
	}

	async function drain(): Promise<void> {
		if (peer === undefined) return;
		const pending = await config.store.entries<Journaled>(NAMESPACE.outbox);
		const ordered = [...pending].sort((left, right) => left.value.seq - right.value.seq);
		const stalled = new Set<string>();
		for (const entry of ordered) {
			const { kind, args, id } = entry.value;
			if (stalled.has(kind)) continue;
			// Through `send`, so a call already in flight from a direct call shares its promise instead of going twice.
			const outcome = await send(kind, id, args);
			if (outcome.status === "pending") {
				stalled.add(kind);
				continue;
			}
			if (outcome.status === "refused") {
				logger.warn("a journaled call was refused for good", { id, detail: outcome.reason });
				continue;
			}
			logger.info("replayed a journaled call", { id });
		}
	}
}

/** A stable id this connector mints for one act. Monotonic enough to sort, unique enough to deduplicate. */
function mintId(prefix: string, now: () => number): string {
	return `${prefix}-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function httpOrigin(url: string): string {
	const parsed = new URL(url);
	return `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`;
}
