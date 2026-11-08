/**
 * `/api/connector`: one connector-initiated JSON-RPC socket, and the runtime behind it.
 *
 * The protocol is `packages/protocol` and its prose is `packages/protocol/PROTOCOL.md`; this file is mason's end of it.
 * Four things live here and they are deliberately in one module, because they are one object's lifetime:
 *
 * 1. **Admission.** `mason/submit` places ordinary human conversation, carried by the one actor the entry calls its
 *    owner or by nobody at all; `mason/fire` fires a hook and never becomes conversation. Both are claimed durably before
 *    they are acknowledged, and the claim is deduplicated on the sender's id forever — the durable log never forgets a
 *    request id, so a resend after a restart is the same act.
 * 2. **The handshake is a ceiling.** The answer is what the operator granted, narrowed by what the connector advertised.
 *    A face the entry does not grant is named in `inactive` rather than dropped, and a scope, an actor, a room, a kind or
 *    a command outside the grant is a refusal.
 * 3. **No state is pushed.** A connector renders what it is sent: a reply, streamed and then final, and a control's
 *    answer. There is no snapshot, no delta and no subscription; the projection is mason's own reading of the
 *    transcript, not a second copy for a surface that already has one.
 * 4. **Delivery.** A reply committed as an `app.reply` entry is owed to the connector it targets. The outbox sends it,
 *    records the acknowledgement as an `app.delivery` entry, resends what was never acknowledged, and never retries an
 *    `uncertain` answer — a person who received the same message twice is the failure this arrangement exists to avoid.
 *
 * What is *not* here: the owner's token. A connector credential opens this socket and the attachment endpoints and
 * nothing else; the config is read per request, so a revoke lands on the next connection rather than the next restart.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { basename, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, EntryRecord, SubmissionDraft } from "@earendil-works/pi-durable";
import { ConversationBusy } from "@earendil-works/pi-durable";
import {
	type Capability,
	CONTROL_OPS,
	type ControlOp,
	type ControlParams,
	type ControlResult,
	type DeliveryAck,
	type DeliveryFinalParams,
	ERROR_CODE,
	type ErrorCode,
	type HelloRequest,
	type HelloResult,
	type Limits,
	METHOD,
	type Origin,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	type ProtocolErrorData,
	type SubmitParams,
	versionsCompatible,
} from "mason-protocol";
import type { WebSocket } from "ws";
import { CONNECTOR_ENTRY_KIND, DELIVERY_ENTRY_KIND, REPLY_ENTRY_KIND, REPLY_TOOL } from "../shared/contract.ts";
import { ATTACHMENT_LIMIT, type AttachmentStore } from "./attachments.ts";
import { commandTarget, runCommand } from "./commands.ts";
import { authenticateConnector, type ConnectorGrant, connectorGrantFor, grantedActors } from "./connectors.ts";
import { currentHouse } from "./house.ts";
import { currentIntegrations, type Integration } from "./integrations.ts";
import {
	CONNECTOR_CONTROL_LIMIT,
	CONNECTOR_FIRE_LIMIT,
	CONNECTOR_SUBMISSION_LIMIT,
	type FireLimiter,
} from "./limits.ts";
import { type ReplyRecord, replyRecordOf, targetOfOrigin, turnOriginOf } from "./replies.ts";
import type { AgentRuntime } from "./runtime.ts";
import { deriveRunStatus, isBusy, queuedSubmissions } from "./status.ts";

/** The path a connector opens. Beside the Chord socket rather than inside it: one door, one contract. */
export const CONNECTOR_PATH = "/api/connector";

/** What `compact` may be told, in characters: a line of instruction, not a document. */
export const COMMAND_INSTRUCTION_MAX = 200;

/** An inbound frame larger than this is not a submission or an event; it is somebody trying to fill memory. */
const FRAME_MAX_BYTES = 256 * 1024;

/** No message for this long closes the socket. The connector's own keepalive is every 20 s. */
const IDLE_TIMEOUT_MS = 60_000;

/** How long a delivery acknowledgement may take before the reply stays owed and is resent on the next opportunity. */
const DELIVERY_TIMEOUT_MS = 15_000;

/** How long a connector told its submission was refused mid-turn should wait before trying again: one turn's worth. */
const BUSY_RETRY_MS = 5_000;

/** State and delivery share one counter: `seq` is monotonic per socket, and a delivery is not a second stream. */
type Seq = number;

/** What a JSON-RPC error carries, as the protocol's `data`. */
class SessionError extends Error {
	readonly data: ProtocolErrorData;

	constructor(data: ProtocolErrorData) {
		super(data.message);
		this.name = "SessionError";
		this.data = data;
	}
}

function refused(code: ErrorCode, message: string, extra: Partial<ProtocolErrorData> = {}): SessionError {
	return new SessionError({ code, message, ...extra });
}

function protocolError(error: unknown): ProtocolErrorData {
	if (error instanceof SessionError) return error.data;
	return {
		code: ERROR_CODE.internal,
		message: error instanceof Error ? error.message : String(error),
	};
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* JSON-RPC framing                                                                                                  */
/* ---------------------------------------------------------------------------------------------------------------- */

interface Frame {
	readonly jsonrpc?: unknown;
	readonly id?: unknown;
	readonly method?: unknown;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: unknown;
}

function frameId(frame: Frame): string | number | null {
	const id = frame.id;
	return typeof id === "string" || typeof id === "number" ? id : null;
}

/** One outbound call waiting for its answer, so a lost answer times out instead of hanging the outbox. */
interface Pending {
	resolve(value: unknown): void;
	reject(error: unknown): void;
	timer: ReturnType<typeof setTimeout>;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* The door                                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

export interface ConnectorDoorOptions {
	readonly runtime: AgentRuntime;
	/** Where an uploaded file is written for the model to read, when a submission carries one. */
	readonly workspaceDir: string;
	readonly attachments: AttachmentStore;
	/** One limiter for the process, shared with the attachment routes: a class budget is the connector's, not a socket's. */
	readonly limiter: FireLimiter;
	readonly log?: (line: string) => void;
	readonly now?: () => number;
	/** How the door picks the config a socket is authenticated against. A test reads the home it booted. */
	readonly home?: string;
}

export interface ConnectorDoor {
	/**
	 * Authenticate an upgrade and hand the socket its session. The caller has already routed the request to this path;
	 * a refusal closes the socket with a reason and says why in the log.
	 */
	attach(socket: WebSocket, request: IncomingMessage): Promise<void>;
	/** Send what a connector is owed now — after a connect, and after every view change. */
	flush(): Promise<void>;
	close(): Promise<void>;
}

export async function createConnectorDoor(options: ConnectorDoorOptions): Promise<ConnectorDoor> {
	const log = options.log ?? ((line: string) => console.log(line));
	const home = options.home ?? currentHouse().home;
	const sessions = new Map<string, ConnectorSession>();
	const conversation = await options.runtime.conversation();
	const door: ConnectorDoor = {
		attach,
		flush,
		close: async () => {
			await watch.dispose();
			for (const session of [...sessions.values()]) session.close("mason is shutting down");
			sessions.clear();
		},
	};

	let latest: ConversationView | undefined;
	let flushing: Promise<void> | undefined;
	let dirty = false;
	const closed = false;

	// One watch for the whole door: every connector's streaming reply, and the outbox, read the same revision. A per-socket
	// watch would be one listener per connector on a log that already fans out to every browser.
	const watch = await options.runtime.viewState(BACKGROUND_CONTEXT);
	const unsubscribe = watch.subscribe((view) => {
		latest = view;
		for (const session of sessions.values()) session.streamChanged(view);
		void flush();
	});
	// The acquisition revision is delivered by `subscribe` itself; nothing to seed.
	await Promise.resolve(unsubscribe);

	return door;

	async function attach(socket: WebSocket, request: IncomingMessage): Promise<void> {
		if (closed) {
			socket.close(1001, "mason is shutting down");
			return;
		}
		// The socket is wrapped before the first await. Authentication reads the config from disk, and a frame that arrives
		// while it does would otherwise be dropped by a socket with no listener yet — a connector that is refused then
		// retries, but one whose hello is lost sits on a dead socket until its timeout. Chord wraps its own sockets for
		// exactly this reason.
		const early: string[] = [];
		let session: ConnectorSession | undefined;
		let closedEarly = false;
		const collect = (data: unknown): void => {
			if (session === undefined) early.push(String(data));
		};
		const earlyClose = (): void => {
			closedEarly = true;
		};
		socket.on("message", collect);
		socket.on("close", earlyClose);
		// A store mason cannot read is a refusal, not a crash: `attach` is called from a socket handler with no one to
		// catch it, so a throw here used to be an unhandled rejection that took the server down and left the socket open
		// with its early listeners attached.
		let auth: Awaited<ReturnType<typeof authenticateConnector>>;
		try {
			auth = await authenticateConnector(request, home, currentIntegrations());
		} catch (error) {
			socket.off("message", collect);
			socket.off("close", earlyClose);
			log(`[connector] refused a socket: ${error instanceof Error ? error.message : String(error)}`);
			socket.close(1011, "the store this server reads is unreadable");
			return;
		}
		socket.off("message", collect);
		socket.off("close", earlyClose);
		if (closedEarly) return;
		if (!auth.ok) {
			log(`[connector] refused a socket (${auth.reason}) from ${request.headers.origin ?? "a program"}`);
			socket.close(1008, "unauthorized");
			return;
		}
		const name = auth.identity.name;
		const existing = sessions.get(name);
		if (existing !== undefined) {
			log(`[connector] ${name}: a second socket supersedes the first`);
			existing.close("superseded by a second socket for this connector");
		}
		session = new ConnectorSession({
			socket,
			name,
			integration: auth.identity.integration,
			runtime: options.runtime,
			conversation,
			workspaceDir: options.workspaceDir,
			attachments: options.attachments,
			limiter: options.limiter,
			log,
			now: options.now ?? Date.now,
			view: () => latest,
			close: () => {
				if (sessions.get(name) === session) sessions.delete(name);
			},
		});
		const created = session;
		sessions.set(name, created);
		// A connector that reconnects is owed everything its last socket never acknowledged. After the handshake: nothing
		// is sent on a socket that has not said who it is.
		created.onReady = () => {
			void flush();
		};
		for (const text of early) created.receive(text);
	}

	/**
	 * Send every reply an open connector is owed, in the order they were committed. One flush at a time, coalesced: a
	 * flush asked for while one is running is a rerun of the whole door, never a second pass for one connector — the
	 * replies a connector is owed are read from the transcript, so the pass that runs last is the one that is right.
	 */
	async function flush(): Promise<void> {
		if (flushing !== undefined) {
			dirty = true;
			return flushing;
		}
		flushing = (async () => {
			do {
				dirty = false;
				const view = latest;
				if (view === undefined) return;
				for (const [session, records] of owedReplies(view, sessions)) {
					for (const record of records) {
						if (session.closed) break;
						try {
							await sendFinal(session, record);
						} catch (error) {
							// The connector has the message but the acknowledgement could not be written down. Leaving it owed
							// is the honest answer: the next pass resends it under the same id and the connector's ledger
							// answers `duplicate`. Throwing would abandon every other connector's reply mid-pass.
							log(
								`[connector] ${session.name}: ${record.deliveryId} could not be recorded: ` +
									(error instanceof Error ? error.message : String(error)),
							);
						}
					}
				}
			} while (dirty);
		})().finally(() => {
			flushing = undefined;
		});
		return flushing;
	}

	/** The committed replies each open session still owes: its target, no acknowledgement recorded, in entry order. */
	function owedReplies(
		view: ConversationView,
		open: ReadonlyMap<string, ConnectorSession>,
	): Array<[ConnectorSession, ReplyRecord[]]> {
		const entries = (view.entries ?? []) as readonly EntryRecord[];
		const acknowledged = new Set<string>();
		for (const entry of entries) {
			if (entry.kind !== DELIVERY_ENTRY_KIND) continue;
			const data = entry.data as { deliveryId?: unknown } | undefined;
			if (typeof data?.deliveryId === "string") acknowledged.add(data.deliveryId);
		}
		const byConnector = new Map<string, ReplyRecord[]>();
		for (const entry of entries) {
			if (entry.kind !== REPLY_ENTRY_KIND) continue;
			const record = replyRecordOf(entry);
			if (record?.target === undefined || acknowledged.has(record.deliveryId)) continue;
			const name = record.target.connector;
			const list = byConnector.get(name) ?? [];
			list.push(record);
			byConnector.set(name, list);
		}
		const owed: Array<[ConnectorSession, ReplyRecord[]]> = [];
		for (const [name, records] of byConnector) {
			const session = open.get(name);
			if (session === undefined || session.closed || !session.ready) continue;
			owed.push([session, records]);
		}
		return owed;
	}

	/** One `connector/delivery.final`, and its acknowledgement written down — whatever it says, including `uncertain`. */
	async function sendFinal(session: ConnectorSession, record: ReplyRecord): Promise<void> {
		const target = record.target;
		if (target === undefined) return;
		const origin: Origin = record.origin ?? {
			connector: target.connector,
			externalConversationId: target.externalConversationId,
		};
		const params: DeliveryFinalParams = {
			deliveryId: record.deliveryId,
			origin,
			seq: session.nextSeq(),
			blocks: record.blocks,
			target,
		};
		const ack = await session.requestDelivery(params);
		if (ack === undefined) {
			log(`[connector] ${session.name}: ${record.deliveryId} was not acknowledged; it stays owed`);
			return;
		}
		await recordDelivery(conversation, record.deliveryId, ack);
		log(
			`[connector] ${session.name}: ${record.deliveryId} ${ack.status}${ack.detail === undefined ? "" : ` (${ack.detail})`}`,
		);
	}
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* One socket                                                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */

interface SessionOptions {
	readonly socket: WebSocket;
	readonly name: string;
	readonly integration: Integration;
	readonly runtime: AgentRuntime;
	readonly conversation: Conversation;
	readonly workspaceDir: string;
	readonly attachments: AttachmentStore;
	readonly limiter: FireLimiter;
	readonly log: (line: string) => void;
	readonly now: () => number;
	readonly view: () => ConversationView | undefined;
	readonly close: () => void;
}

interface UserInputImage {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

interface UserInputText {
	readonly type: "text";
	readonly text: string;
}

type UserInput = string | Array<UserInputText | UserInputImage>;

export class ConnectorSession {
	readonly name: string;
	/** Set once the handshake answered: until then nothing but `mason/hello` is accepted. */
	ready = false;
	closed = false;
	/** Called after the handshake: the door flushes what this connector is owed. */
	onReady: (() => void) | undefined;

	readonly #socket: WebSocket;
	readonly #integration: Integration;
	readonly #grant: ConnectorGrant;
	readonly #runtime: AgentRuntime;
	readonly #conversation: Conversation;
	readonly #workspaceDir: string;
	readonly #attachments: AttachmentStore;
	readonly #limiter: FireLimiter;
	readonly #log: (line: string) => void;
	readonly #now: () => number;
	readonly #view: () => ConversationView | undefined;
	readonly #onClose: () => void;
	readonly #pending = new Map<string, Pending>();
	#idle: ReturnType<typeof setTimeout>;
	readonly #delivering = new Set<string>();
	readonly #streaming = new Map<string, { readonly callId: string; readonly text: string }>();
	#capabilities: readonly Capability[] = [];
	#seq: Seq = 0;
	#version = "0.0.0";

	constructor(options: SessionOptions) {
		this.#socket = options.socket;
		this.name = options.name;
		this.#integration = options.integration;
		this.#grant = options.integration.connector as ConnectorGrant;
		this.#runtime = options.runtime;
		this.#conversation = options.conversation;
		this.#workspaceDir = options.workspaceDir;
		this.#attachments = options.attachments;
		this.#limiter = options.limiter;
		this.#log = options.log;
		this.#now = options.now;
		this.#view = options.view;
		this.#onClose = options.close;
		this.#idle = setTimeout(() => this.close("no message for 60 s"), IDLE_TIMEOUT_MS);
		this.#idle.unref?.();
		this.#socket.on("message", (data) => this.receive(String(data)));
		this.#socket.on("close", () => this.close("the socket closed"));
		this.#socket.on("error", (error) => {
			this.#log(`[connector] ${this.name}: socket error (${error.message})`);
			this.close("socket error");
		});
	}

	get granted(): ConnectorGrant {
		return this.#grant;
	}

	get capabilities(): readonly Capability[] {
		return this.#capabilities;
	}

	/** The next number a frame carries. Monotonic per socket, shared by state and delivery. */
	nextSeq(): Seq {
		this.#seq += 1;
		return this.#seq;
	}

	close(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.#idle);
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.#pending.clear();
		this.#onClose();
		try {
			this.#socket.close(1000, reason.slice(0, 120));
		} catch {
			// A socket already gone is a socket that has nothing to close.
		}
	}

	/** One text frame, from the socket or from the queue `attach` filled while it authenticated. */
	receive(text: string): void {
		clearTimeout(this.#idle);
		this.#idle = setTimeout(() => this.close("no message for 60 s"), IDLE_TIMEOUT_MS);
		this.#idle.unref?.();
		if (Buffer.byteLength(text, "utf8") > FRAME_MAX_BYTES) {
			this.close(`a frame over ${FRAME_MAX_BYTES} bytes`);
			return;
		}
		let frame: Frame;
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
			frame = parsed as Frame;
		} catch {
			this.#send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "the frame is not JSON" } });
			return;
		}
		void this.#dispatch(frame);
	}

	async #dispatch(frame: Frame): Promise<void> {
		const method = typeof frame.method === "string" ? frame.method : undefined;
		// An answer to something this side asked: settle it and stop.
		if (method === undefined) {
			if (frame.id !== undefined) this.#settle(frame);
			return;
		}
		const id = frame.id;
		try {
			const result = await this.#handle(method, frame.params);
			// A notification has no id to answer. Everything the protocol defines inbound is a request, so this is only the
			// shape of a frame the connector should not have sent.
			if (id === undefined) return;
			this.#send({ jsonrpc: "2.0", id: frameId(frame), result });
		} catch (error) {
			if (id === undefined) return;
			const data = protocolError(error);
			if (!(error instanceof SessionError)) this.#log(`[connector] ${this.name}: ${method} failed: ${data.message}`);
			this.#send({
				jsonrpc: "2.0",
				id: frameId(frame),
				error: { code: error instanceof SessionError ? -32000 : -32603, message: data.message, data },
			});
			if (data.code === ERROR_CODE.protocolMismatch) this.close(data.message);
		}
	}

	async #handle(method: string, params: unknown): Promise<unknown> {
		if (method === METHOD.hello) {
			if (this.ready)
				throw refused(ERROR_CODE.invalidRequest, "mason/hello has already been answered on this socket");
			return this.#hello(params);
		}
		if (!this.ready) {
			throw refused(ERROR_CODE.invalidRequest, "the first call on a socket is mason/hello");
		}
		switch (method) {
			case METHOD.submit:
				return this.#submit(params as SubmitParams);
			case METHOD.fire:
				return this.#fire(
					params as { fireId: string; kind: string; payload: unknown; origin?: Origin; summary?: string },
				);
			case METHOD.control:
				return this.#control(params as ControlParams);
			case METHOD.ping:
				return { at: this.#now() };
			default:
				throw new SessionError({
					code: ERROR_CODE.invalidRequest,
					message: `${method} is not a method mason answers`,
				});
		}
	}

	/* ------------------------------------------------------------------------------------------------------------ */
	/* Handshake                                                                                                    */
	/* ------------------------------------------------------------------------------------------------------------ */

	#hello(params: unknown): HelloResult {
		if (typeof params !== "object" || params === null) {
			throw refused(ERROR_CODE.invalidRequest, "mason/hello needs a request object");
		}
		const request = params as HelloRequest;
		const protocol = request.protocol;
		if (protocol === undefined || !versionsCompatible(protocol)) {
			throw refused(
				ERROR_CODE.protocolMismatch,
				`this mason speaks protocol major ${PROTOCOL_MAJOR}; the connector asked for ${String(protocol?.major)}`,
			);
		}
		if (request.connector?.name !== this.name) {
			throw refused(
				ERROR_CODE.notAuthenticated,
				`this credential speaks for "${this.name}", not "${String(request.connector?.name)}"`,
			);
		}
		if (typeof request.connector.version === "string") this.#version = request.connector.version;
		// The entry is re-read from the boot's snapshot, not from the file: whether the operator granted a face is config,
		// and config is settled at boot. A switched-off entry never reaches here, because authentication checked it.
		const live = connectorGrantFor(currentIntegrations(), this.name);
		if (live === undefined) {
			throw refused(ERROR_CODE.faceNotGranted, `"${this.name}" is not an enabled connector`);
		}
		this.#capabilities = negotiateCapabilities(live.grant, request.faces?.user?.capabilities);
		const hello = this.#helloAnswer(request, live.grant);
		this.ready = true;
		this.#log(
			`[connector] ${this.name} ${this.#version} connected: faces ${Object.keys(hello.faces).join(",") || "none"}` +
				`${hello.inactive === undefined ? "" : `, inactive ${hello.inactive.map((face) => face.face).join(",")}`}`,
		);
		// After the answer has been written, so the connector's own `onSession` runs on a socket that can already take
		// work. Queued on the microtask queue so `hello` is answered first even if a delivery is immediately ready.
		queueMicrotask(() => this.onReady?.());
		return hello;
	}

	#helloAnswer(request: HelloRequest, grant: ConnectorGrant): HelloResult {
		const inactive: Array<{ face: "user" | "tools" | "events"; reason: string }> = [];
		const faces: {
			user?: {
				actors: ReturnType<typeof grantedActors>;
				conversations: HelloResult["faces"]["user"] extends infer U
					? U extends { conversations: infer C }
						? C
						: never
					: never;
				capabilities: readonly Capability[];
			};
			tools?: { url: string };
			events?: { hooks: Record<string, string> };
		} = {};
		if (request.faces?.user !== undefined) {
			if (grant.user === undefined) {
				inactive.push({ face: "user", reason: "the entry grants no user face" });
			} else {
				const actors = grantedActors(grant.user, request.faces.user.actors ?? []);
				if (grant.user.owner !== undefined && actors.length === 0) {
					// Once, at the handshake: the connector advertised no id matching the grant's `owner`, so it holds a user
					// face that can carry words and no voice. Every actor submission will be refused, and this line is what a
					// deployer reads to see why.
					this.#log(
						`[connector] ${this.name}: the entry's owner is actor ${grant.user.owner}, and the connector advertised ` +
							"no actor with that id: every submission that names an actor will be refused",
					);
				}
				faces.user = {
					actors,
					conversations: grant.user.conversations.map((conversation) => ({ ...conversation })),
					capabilities: this.#capabilities,
				};
			}
		}
		if (request.faces?.tools !== undefined) {
			if (this.#integration.mcp === undefined) {
				inactive.push({ face: "tools", reason: "the entry declares no MCP server" });
			} else {
				faces.tools = { url: this.#integration.mcp.url };
			}
		}
		if (request.faces?.events !== undefined) {
			if (grant.events === undefined) {
				inactive.push({ face: "events", reason: "the entry declares no events face" });
			} else {
				faces.events = { hooks: { ...grant.events.hooks } };
				const unmapped = (request.faces.events.kinds ?? []).filter(
					(kind) => !Object.hasOwn(grant.events?.hooks ?? {}, kind),
				);
				if (unmapped.length > 0) {
					inactive.push({ face: "events", reason: `no hook is configured for ${unmapped.join(", ")}` });
				}
			}
		}
		const limits: Limits = {
			submissionsPerMinute: CONNECTOR_SUBMISSION_LIMIT,
			firesPerMinute: CONNECTOR_FIRE_LIMIT,
			controlsPerMinute: CONNECTOR_CONTROL_LIMIT,
			attachmentsPerMinute: ATTACHMENT_LIMIT,
			// The store's own bounds, not the constants: a deployment that narrowed them is what a connector has to obey, and
			// the number it reads here is the number the endpoint enforces.
			attachmentBytes: this.#attachments.maxBytes,
			attachmentTtlMs: this.#attachments.ttlMs,
		};
		return {
			protocol: { major: PROTOCOL_MAJOR, minors: [PROTOCOL_MINOR] },
			connector: this.name,
			faces: faces as HelloResult["faces"],
			...(inactive.length === 0 ? {} : { inactive }),
			capabilities: faces.user === undefined ? [] : faces.user.capabilities,
			// The control vocabulary is part of what the handshake answers with: a connector that was not granted `stop` learns
			// it here rather than by spending a refused call, and the list is the same one `mason/control` holds the call to.
			commands: [...(grant.commands ?? [])],
			limits,
		};
	}

	/* ------------------------------------------------------------------------------------------------------------ */
	/* Admission                                                                                                    */
	/* ------------------------------------------------------------------------------------------------------------ */

	async #submit(params: SubmitParams): Promise<{ accepted: true; id: string; entryId?: string; duplicate?: boolean }> {
		const user = this.#grant.user;
		if (user === undefined) throw refused(ERROR_CODE.faceNotGranted, "this connector holds no user face");
		const submissionId = params?.submissionId;
		if (typeof submissionId !== "string" || submissionId === "") {
			throw refused(ERROR_CODE.invalidRequest, "mason/submit needs a non-empty submissionId", {
				field: "submissionId",
			});
		}
		const origin = params.origin;
		if (typeof origin !== "object" || origin === null) {
			throw refused(ERROR_CODE.invalidRequest, "mason/submit needs an origin", { field: "origin" });
		}
		if (origin.connector !== this.name) {
			throw refused(
				ERROR_CODE.invalidRequest,
				`the origin names "${String(origin.connector)}", and this socket speaks for "${this.name}"`,
				{ field: "origin.connector" },
			);
		}
		if (typeof origin.externalConversationId !== "string" || origin.externalConversationId === "") {
			throw refused(ERROR_CODE.invalidRequest, "the origin needs an externalConversationId", {
				field: "origin.externalConversationId",
			});
		}
		if (!Array.isArray(params.content)) {
			throw refused(ERROR_CODE.invalidRequest, "mason/submit needs content blocks", { field: "content" });
		}
		const requestId = connectorRequestId(this.name, "submission", submissionId);
		const claimed = await this.#claim(requestId);
		if (claimed !== undefined) {
			return {
				accepted: true,
				id: submissionId,
				duplicate: true,
				...(claimed.entry === undefined ? {} : { entryId: String(claimed.entry) }),
			};
		}
		if (!user.conversations.some((entry) => entry.externalConversationId === origin.externalConversationId)) {
			throw refused(
				ERROR_CODE.conversationNotPermitted,
				`"${origin.externalConversationId}" is not a conversation this entry permits`,
			);
		}
		const refusalReason = this.#ownerRefusal(params.actor);
		if (refusalReason !== undefined) throw refused(ERROR_CODE.actorUnknown, refusalReason);
		this.#spend("submission", CONNECTOR_SUBMISSION_LIMIT);
		const content = await this.#userInput(params);
		const submission = await this.#submitInput({
			type: "input",
			requestId,
			content,
			entry: {
				kind: CONNECTOR_ENTRY_KIND,
				data: {
					origin: {
						connector: origin.connector,
						externalConversationId: origin.externalConversationId,
						...(origin.externalMessageId === undefined ? {} : { externalMessageId: origin.externalMessageId }),
						...(origin.externalActorId === undefined ? {} : { externalActorId: origin.externalActorId }),
					},
				},
			},
			...(params.mode === "steer" || params.mode === "followUp" || params.mode === "reject"
				? { whenBusy: params.mode }
				: {}),
		});
		const record = await submission.status(BACKGROUND_CONTEXT);
		this.#log(`[connector] ${this.name}: submission ${submissionId} in ${origin.externalConversationId}`);
		return {
			accepted: true,
			id: submissionId,
			...(record.entry === undefined ? {} : { entryId: String(record.entry) }),
		};
	}

	/**
	 * `submit`, with the refusal a connector's own `mode: "reject"` asks for mapped to the code it is.
	 *
	 * `whenBusy: "reject"` is the connector saying it would rather be told than queued, so the answer is a refusal it can
	 * act on — not `mason.internal`, which is the one code a client reads as a bug in mason.
	 */
	async #submitInput(draft: SubmissionDraft) {
		try {
			return await this.#conversation.submit(draft, BACKGROUND_CONTEXT);
		} catch (error) {
			if (error instanceof ConversationBusy) {
				throw refused(
					ERROR_CODE.queueOverflow,
					"the conversation is in the middle of a turn and this submission asked to be refused rather than queued",
					{ retryable: true, retryAfterMs: BUSY_RETRY_MS },
				);
			}
			throw error;
		}
	}

	/**
	 * Why this submission may not be placed, or `undefined` when it may.
	 *
	 * The whole of the admission rule, in one place: an actor that is the grant's `owner` is the person mason works for,
	 * an absent actor is a message nobody attributed, and any other actor is a stranger — refused, because a bot with one
	 * owner has no room for a second voice and silently accepting one would put a stranger's words in the owner's mouth.
	 */
	#ownerRefusal(actor: SubmitParams["actor"]): string | undefined {
		if (actor === undefined) return undefined;
		const owner = this.#grant.user?.owner;
		if (owner === undefined) {
			return `this entry names no owner, so an actor cannot speak through it (${String(actor.externalActorId)})`;
		}
		if (typeof actor.externalActorId !== "string" || actor.externalActorId !== owner) {
			return `"${String(actor.externalActorId)}" is not the actor this entry calls its owner`;
		}
		return undefined;
	}

	/**
	 * The words as the model reads them, plus the files they sent.
	 *
	 * Text and markdown blocks become the message, unprefixed: the connector's credential already says who is speaking,
	 * and one person's bot has nobody to tell apart. A file block is fetched from the attachment store and written into
	 * the agent's workspace, because a content id is not something a `read` can open; an image also travels as an image
	 * block, so the model sees it without a tool call.
	 */
	async #userInput(params: SubmitParams): Promise<UserInput> {
		const text: string[] = [];
		const images: UserInputImage[] = [];
		for (const block of params.content) {
			if (block.type === "text" || block.type === "markdown" || block.type === "notice") {
				text.push(block.text);
				continue;
			}
			if (block.type === "file") {
				const read = await this.#attachments.read(this.name, block.contentId);
				if (read.status !== "ok") {
					text.push(
						`[a file could not be attached: ${read.status === "expired" ? "it expired" : "no such upload"}]`,
					);
					continue;
				}
				const path = await this.#attachmentPath(block.contentId, block.name ?? read.attachment.meta.name);
				await writeFile(path, read.attachment.bytes, { mode: 0o600 });
				const type = block.mimeType ?? read.attachment.meta.mimeType;
				if (type.startsWith("image/")) {
					images.push({ type: "image", data: read.attachment.bytes.toString("base64"), mimeType: type });
				}
				text.push(`[file: ${path} — ${type}, ${read.attachment.meta.size} bytes]`);
			}
		}
		const body = text.join("\n");
		if (images.length === 0) return body;
		return [{ type: "text", text: body }, ...images];
	}

	/** Where one attachment is written for `read`: inside the workspace, its name kept but never its path. */
	async #attachmentPath(contentId: string, name: string | undefined): Promise<string> {
		const directory = join(this.#workspaceDir, "inbox");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const safe = basename(name ?? "file")
			.replace(/[^\w.-]+/g, "_")
			.slice(0, 80);
		return join(directory, `${contentId}-${safe}`);
	}

	async #fire(params: {
		fireId: string;
		kind: string;
		payload: unknown;
		origin?: Origin;
		summary?: string;
	}): Promise<{ accepted: true; id: string; entryId?: string; duplicate?: boolean }> {
		const events = this.#grant.events;
		if (events === undefined) throw refused(ERROR_CODE.faceNotGranted, "this connector holds no events face");
		if (typeof params?.fireId !== "string" || params.fireId === "") {
			throw refused(ERROR_CODE.invalidRequest, "mason/fire needs a non-empty fireId", { field: "fireId" });
		}
		if (typeof params.kind !== "string" || params.kind === "") {
			throw refused(ERROR_CODE.invalidRequest, "mason/fire needs a kind", { field: "kind" });
		}
		const hook = events.hooks[params.kind];
		if (hook === undefined) {
			throw refused(ERROR_CODE.kindNotPermitted, `"${params.kind}" fires no hook on this entry`);
		}
		if (params.origin !== undefined) {
			if (params.origin.connector !== this.name) {
				throw refused(ERROR_CODE.invalidRequest, `the origin names another connector than "${this.name}"`, {
					field: "origin.connector",
				});
			}
			const permitted = this.#grant.user?.conversations.some(
				(entry) => entry.externalConversationId === params.origin?.externalConversationId,
			);
			// A fire's origin is where a reply would go, so it has to be a room the entry permits. A connector with no user
			// face may still name an origin only if the entry grants the room — which it cannot without a user face.
			if (permitted !== true) {
				throw refused(
					ERROR_CODE.conversationNotPermitted,
					`"${String(params.origin.externalConversationId)}" is not a conversation this entry permits`,
				);
			}
		}
		const requestId = connectorRequestId(this.name, "fire", params.fireId);
		const claimed = await this.#claim(requestId);
		if (claimed !== undefined) {
			return {
				accepted: true,
				id: params.fireId,
				duplicate: true,
				...(claimed.entry === undefined ? {} : { entryId: String(claimed.entry) }),
			};
		}
		this.#spend("fire", CONNECTOR_FIRE_LIMIT);
		const payload = payloadText(params.payload, params.summary);
		const origin = params.origin;
		const submission = await this.#runtime.hooks.fire(hook, {
			payload,
			kind: params.kind,
			requestId,
			...(origin === undefined
				? {}
				: {
						origin: {
							connector: origin.connector,
							externalConversationId: origin.externalConversationId,
							...(origin.externalMessageId === undefined ? {} : { externalMessageId: origin.externalMessageId }),
							...(origin.externalActorId === undefined ? {} : { externalActorId: origin.externalActorId }),
						},
					}),
		});
		const record = await submission.status(BACKGROUND_CONTEXT);
		this.#log(`[connector] ${this.name}: fire ${params.fireId} (${params.kind}) -> ${hook}`);
		return {
			accepted: true,
			id: params.fireId,
			...(record.entry === undefined ? {} : { entryId: String(record.entry) }),
		};
	}

	/** Whether this request id is already a durable claim, and what the claim says. */
	async #claim(requestId: string): Promise<{ readonly entry?: string } | undefined> {
		return this.#conversation.commit(async (tx) => {
			const existing = await tx.submissionByRequest(this.#conversation.id, requestId);
			if (existing === undefined) return undefined;
			return "entry" in existing && existing.entry !== undefined ? { entry: String(existing.entry) } : {};
		}, BACKGROUND_CONTEXT);
	}

	/* ------------------------------------------------------------------------------------------------------------ */
	/* Control                                                                                                      */
	/* ------------------------------------------------------------------------------------------------------------ */

	async #control(params: ControlParams): Promise<ControlResult> {
		const op = params?.op;
		if (typeof op !== "string" || !(CONTROL_OPS as readonly string[]).includes(op)) {
			// An undeclared op spends nothing: this is the shape a mistyped command has, and a typo must not cost the minute
			// a real `/stop` needs.
			throw refused(
				ERROR_CODE.invalidRequest,
				`${String(op)} is not a control mason knows: the whole set is ${CONTROL_OPS.join(", ")}`,
			);
		}
		const declared = this.#grant.commands ?? [];
		if (!declared.includes(op)) {
			throw refused(ERROR_CODE.invalidRequest, `this entry declares no "${op}" command`);
		}
		// `stop` has a budget of its own beside the controls, so a connector that spent its minute on compactions can still
		// stop the turn those compactions were about.
		this.#spend(op === "stop" ? "stop" : "control", CONNECTOR_CONTROL_LIMIT);
		// `compact` takes instructions and the other three take none: the same shape the event door held a command to, kept
		// here because the socket is now the only way a word arrives. A command that ran with an argument it silently dropped
		// would do something other than what the person asked for.
		const instructions = typeof params.instructions === "string" ? params.instructions : undefined;
		if (op !== "compact" && instructions !== undefined && instructions.trim() !== "") {
			throw refused(
				ERROR_CODE.invalidRequest,
				`"${op}" takes no argument: a command is one word, and only "compact" reads what follows it`,
			);
		}
		if (instructions !== undefined && instructions.length > COMMAND_INSTRUCTION_MAX) {
			throw refused(
				ERROR_CODE.invalidRequest,
				`"compact" takes at most ${COMMAND_INSTRUCTION_MAX} characters of instructions; this one is ${instructions.length}`,
			);
		}
		const requestId =
			typeof params.requestId === "string" && params.requestId !== ""
				? connectorRequestId(this.name, "control", params.requestId)
				: `command:${this.name}:gesture:${randomUUID()}`;
		const reply = await runCommand(await commandTarget(this.#runtime), requestId, op as ControlOp, instructions);
		this.#log(`[connector] ${this.name}: ${op}${reply === undefined ? " (already ran)" : ""}`);
		return {
			handled: true,
			op: op as ControlOp,
			...(reply === undefined ? { reply: "" } : { reply }),
			...(op === "status"
				? {
						status: {
							runStatus: deriveRunStatus(this.#view()),
							busy: isBusy(this.#view()),
							queued: queuedSubmissions(this.#view()),
							commands: [...CONTROL_OPS],
						},
					}
				: {}),
		};
	}

	/* ------------------------------------------------------------------------------------------------------------ */
	/* Delivery                                                                                                     */
	/* ------------------------------------------------------------------------------------------------------------ */

	/**
	 * One `connector/delivery.final`, answered by the connector's ack.
	 *
	 * A second flush that reaches the same delivery while the first is in flight must not send it twice on one socket:
	 * the outbox's ack has not been written yet, and two identical requests would be two vendor sends. The in-flight set
	 * is what holds that door shut; a reconnect is a new socket with an empty set and the connector's own ledger is what
	 * deduplicates there.
	 */
	async requestDelivery(params: DeliveryFinalParams): Promise<DeliveryAck | undefined> {
		if (this.closed || !this.ready) return undefined;
		if (this.#delivering.has(params.deliveryId)) return undefined;
		this.#delivering.add(params.deliveryId);
		try {
			const answer = await this.#request(METHOD.deliveryFinal, params, DELIVERY_TIMEOUT_MS);
			if (!isAck(answer)) {
				return {
					status: "uncertain",
					detail: "the connector answered the delivery with something that is not an acknowledgement",
				};
			}
			return answer;
		} catch (error) {
			// A timeout, or a socket that died mid-request: the connector may or may not have sent it, so the reply stays owed
			// and the connector's own ledger answers `duplicate` or `uncertain` when it is resent.
			this.#log(`[connector] ${this.name}: delivery ${params.deliveryId} unanswered (${errorText(error)})`);
			return undefined;
		} finally {
			this.#delivering.delete(params.deliveryId);
		}
	}

	/** Called by the door on every committed revision: the streaming reply, if one is in flight. */
	streamChanged(view: ConversationView): void {
		try {
			this.#streamReply(view);
		} catch (error) {
			this.#log(`[connector] ${this.name}: streaming failed: ${errorText(error)}`);
		}
	}

	/**
	 * A reply being written right now, for an origin that claimed `streaming`: `start`, then `delta`s under one id.
	 *
	 * The id is the one the committed entry will carry — `reply:<callId>` — so the final is the same delivery and a
	 * connector never sees two. `start` carries the text written so far and each `delta` only the suffix, which is what an
	 * appending receiver needs. A call that disappears without an entry — the tool answered without committing one, a
	 * failed attempt gave way to a retry, or the turn ended — was withdrawn before it was final: `cancel`.
	 */
	#streamReply(view: ConversationView): void {
		if (!this.#capabilities.includes("streaming")) return;
		const origin = turnOriginOf((view.entries ?? []) as readonly EntryRecord[]);
		if (origin.kind !== "connector" || origin.origin.connector !== this.name) return;
		const generation = (view.docs["pi.live"] as { generation?: { message?: unknown; retry?: unknown } } | undefined)
			?.generation;
		// A failed attempt waiting to retry has already dropped its message: whatever it streamed is not coming back, so this
		// is the one moment in a running turn where the words on the screen are known to be dead. The replacement attempt
		// clears `retry` before it writes, which is why this reads "cancel now" and never "wait".
		const retrying = generation?.retry !== undefined;
		const live = generation?.message;
		const calls = Array.isArray((live as { content?: unknown } | undefined)?.content)
			? ((live as { content: unknown[] }).content as Array<{
					type?: unknown;
					id?: unknown;
					name?: unknown;
					arguments?: unknown;
				}>)
			: [];
		const call = calls
			.filter((part) => part.type === "toolCall" && part.name === REPLY_TOOL && typeof part.id === "string")
			.at(-1);
		const deliveryId = call === undefined ? undefined : `reply:${call.id}`;
		const committed = new Set(
			((view.entries ?? []) as readonly EntryRecord[])
				.filter((entry) => entry.kind === REPLY_ENTRY_KIND)
				.map((entry) => replyRecordOf(entry)?.deliveryId),
		);
		// A tool call leaves the live message twice in a healthy turn, and neither is a withdrawal: once when the assistant
		// message is committed and the reply entry follows as the tool runs, once when the turn ends having delivered it. So
		// a call the live message no longer carries is not evidence by itself; what makes the entry impossible is the tool
		// answering without committing a reply, a failed attempt giving way to a retry, or the turn ending mid-write.
		const answered = new Set(
			((view.entries ?? []) as readonly EntryRecord[])
				.filter((entry) => entry.kind === "pi.tool-result")
				.map((entry) => (entry as { model?: Array<{ toolCallId?: unknown }> }).model?.[0]?.toolCallId)
				.filter((callId): callId is string => typeof callId === "string"),
		);
		const running = isBusy(view);
		for (const [id, stream] of [...this.#streaming]) {
			// The entry landed: the final carries the rest, and a cancel here would withdraw a delivery that is about to be
			// sent.
			if (committed.has(id)) {
				this.#streaming.delete(id);
				continue;
			}
			const stillWriting = calls.some((part) => part.type === "toolCall" && part.id === stream.callId);
			if (stillWriting) continue;
			// Still running, this call has not answered yet, and no retry has replaced it: that is the handover to the tool,
			// not the end of the delivery, so the stream is left alone.
			if (running && !retrying && !answered.has(stream.callId)) continue;
			this.#streaming.delete(id);
			this.#sendNotification(METHOD.deliveryCancel, {
				deliveryId: id,
				reason: "the reply was withdrawn before it was final",
			});
		}
		if (call === undefined || deliveryId === undefined || committed.has(deliveryId)) return;
		const text =
			typeof (call.arguments as { message?: unknown } | undefined)?.message === "string"
				? (call.arguments as { message: string }).message
				: "";
		if (text === "") return;
		const previous = this.#streaming.get(deliveryId);
		if (previous === undefined) {
			this.#streaming.set(deliveryId, { callId: call.id as string, text });
			this.#sendNotification(METHOD.deliveryStart, {
				deliveryId,
				origin: origin.origin,
				seq: this.nextSeq(),
				blocks: [{ type: "text", text }],
				target: targetOfOrigin(origin.origin),
			});
			return;
		}
		if (text === previous.text) return;
		const suffix = text.startsWith(previous.text) ? text.slice(previous.text.length) : text;
		this.#streaming.set(deliveryId, { callId: previous.callId, text });
		this.#sendNotification(METHOD.deliveryDelta, {
			deliveryId,
			seq: this.nextSeq(),
			blocks: [{ type: "text", text: suffix }],
		});
	}

	/* ------------------------------------------------------------------------------------------------------------ */
	/* Budget, framing                                                                                              */
	/* ------------------------------------------------------------------------------------------------------------ */

	#spend(kind: "submission" | "fire" | "control" | "stop", perMinute: number): void {
		const wait = this.#limiter.take(`connector:${kind}:${this.name}`, perMinute);
		if (wait === undefined) return;
		throw refused(ERROR_CODE.rateLimited, `this connector has spent its ${kind} budget for the minute`, {
			retryable: true,
			retryAfterMs: Math.min(wait * 1000, 60_000),
		});
	}

	#send(frame: unknown): void {
		if (this.closed) return;
		try {
			this.#socket.send(JSON.stringify(frame));
		} catch (error) {
			this.#log(`[connector] ${this.name}: a frame could not be written (${errorText(error)})`);
		}
	}

	#sendNotification(method: string, params: unknown): void {
		this.#send({ jsonrpc: "2.0", method, params });
	}

	/** An outbound request: answered by the next frame with this id, or rejected when the socket or the timer ends it. */
	#request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("the socket is closed"));
		const id = `m${++outbound}`;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`${method} was not answered in ${timeoutMs} ms`));
			}, timeoutMs);
			timer.unref?.();
			this.#pending.set(id, { resolve, reject, timer });
			this.#send({ jsonrpc: "2.0", id, method, params });
		});
	}

	#settle(frame: Frame): void {
		const id = frame.id;
		if (typeof id !== "string") return;
		const pending = this.#pending.get(id);
		if (pending === undefined) return;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		if (frame.error !== undefined) {
			pending.reject(new Error(errorMessageOf(frame.error)));
			return;
		}
		pending.resolve(frame.result);
	}
}

/** Write one acknowledgement down as its own entry: the outbox's record that this delivery is no longer owed. */
async function recordDelivery(conversation: Conversation, deliveryId: string, ack: DeliveryAck): Promise<void> {
	await conversation.commit(
		(tx) =>
			tx.appendEntry(conversation.id, {
				kind: DELIVERY_ENTRY_KIND,
				data: {
					deliveryId,
					status: ack.status,
					...(ack.detail === undefined ? {} : { detail: ack.detail }),
				},
			}),
		BACKGROUND_CONTEXT,
	);
}

/** Outbound request ids: only unique within one socket, which is all a JSON-RPC id has to be. */
let outbound = 0;

/** Capabilities the connector advertised, narrowed to the operator's list when one was configured. */
function negotiateCapabilities(grant: ConnectorGrant, advertised: readonly Capability[] | undefined): Capability[] {
	const claimed = Array.isArray(advertised) ? advertised : [];
	const ceiling = grant.user?.capabilities;
	return (ceiling === undefined ? claimed : claimed.filter((capability) => ceiling.includes(capability))).filter(
		(capability, index, all) => all.indexOf(capability) === index,
	);
}

/**
 * A delivery acknowledgement, as far as this side trusts it: one of the four statuses, and a `detail` for the two that
 * have to say why. `uncertain` and `rejected` without one would be a status the reader cannot act on.
 */
function isAck(value: unknown): value is DeliveryAck {
	if (typeof value !== "object" || value === null) return false;
	const ack = value as Record<string, unknown>;
	if (ack.status === "delivered" || ack.status === "duplicate") {
		return ack.detail === undefined || typeof ack.detail === "string";
	}
	if (ack.status !== "uncertain" && ack.status !== "rejected") return false;
	return typeof ack.detail === "string";
}

function errorMessageOf(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return "the connector answered with an error";
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The text a fire's `payload` becomes: its own string, or the JSON, with the summary above it when the sender sent one. */
function payloadText(payload: unknown, summary: string | undefined): string {
	const body = typeof payload === "string" ? payload : payload === undefined ? "" : JSON.stringify(payload, null, 2);
	const head = typeof summary === "string" && summary.trim() !== "" ? `${summary.trim()}\n` : "";
	return head + body;
}

/** A request id namespaced by connector and act: the durable log holds it forever, so two senders cannot collide. */
export function connectorRequestId(connector: string, act: "submission" | "fire" | "control", id: string): string {
	return `connector:${connector}:${act}:${id}`;
}
