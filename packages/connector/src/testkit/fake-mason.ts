/**
 * A fake mason, on the far end of the same socket a real one holds.
 *
 * It exists so a connector can prove itself without a running mason, which is the only way a community connector can be
 * tested at all. It is deliberately a real implementation of the *server* half rather than a mock: it enforces the
 * version, the grants, the budgets, the one owner actor and the deduplication, because a mock that says yes to everything
 * proves nothing about a connector that has to survive a no.
 *
 * What it is not: mason. The conformance suite checks the connector's side of the contract, and a real mason checks
 * mason's. Both are needed, and neither substitutes for the other.
 */
import {
	type Capability,
	type ControlParams,
	type DeliveryAck,
	type DeliveryFinalParams,
	ERROR_CODE,
	type ExternalActor,
	type ExternalConversation,
	type FaceName,
	type HelloRequest,
	type HelloResult,
	type InteractionAck,
	type InteractionAnswerParams,
	type InteractionAnswerResult,
	type InteractionRequestParams,
	type Limits,
	METHOD,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	type ProtocolErrorData,
	type StateDeltaParams,
	type StateSnapshotParams,
	type StateSubscribeResult,
	type SubmitParams,
} from "mason-protocol";
import type { Fetcher } from "../attachments.ts";
import { protocolFailure } from "../jsonrpc.ts";
import { type Link, type LinkFactory, linkPair } from "../link.ts";
import { PeerError, RpcPeer } from "../transport.ts";

/** One frame the fake saw, in order. Assertions read this rather than guessing from side effects. */
export interface Recorded {
	readonly at: number;
	readonly direction: "in" | "out";
	readonly method: string;
	readonly params: unknown;
}

export interface DeliveryRecord {
	readonly deliveryId: string;
	readonly params: DeliveryFinalParams;
	readonly sentAt: number;
	ack?: DeliveryAck;
	attempts: number;
	/** A call is on the wire right now. Replay must leave it alone: a record still in flight on this connection is not a
	 * record a reconnect lost. */
	sending?: boolean;
	/** The answer was sent and dropped on the way back, which is the only way a lost acknowledgement is knowable. */
	lostAck?: boolean;
}

export interface InteractionRecord {
	readonly permissionId: string;
	readonly params: InteractionRequestParams;
	ack?: InteractionAck;
	answer?: InteractionAnswerResult;
	answerParams?: InteractionAnswerParams;
	sending?: boolean;
}

export interface FakeMasonGrants {
	readonly user?: {
		/**
		 * The one external actor id mason accepts as the person it works for. The handshake answers with the actor the
		 * connector advertised under that id; a submission that names any other is refused, and one that names nobody is
		 * accepted.
		 */
		readonly owner?: string;
		readonly conversations?: readonly ExternalConversation[];
		readonly capabilities?: readonly Capability[];
	};
	readonly tools?: { readonly url: string };
	/** `kind` → hook id. A kind absent from this map is refused. */
	readonly events?: Readonly<Record<string, string>>;
	/** The state scopes this connector mirrors. A scope absent from here is refused, not narrowed. */
	readonly state?: readonly string[];
}

export interface FakeMasonOptions {
	/** The name mason configured this connector under. */
	readonly connector?: string;
	readonly granted?: FakeMasonGrants;
	readonly capabilities?: readonly Capability[];
	readonly limits?: Partial<Limits>;
	/** What this fake speaks, so a mismatch can be staged. */
	readonly protocol?: { readonly major: number; readonly minors?: readonly number[] };
	readonly now?: () => number;
	/** Content ids the transfer endpoint will hand out, and the cap it enforces. */
	readonly attachmentBytes?: number;
}

export interface FakeMason {
	readonly url: string;
	readonly link: LinkFactory;
	readonly fetch: Fetcher;
	readonly log: readonly Recorded[];
	readonly submissions: readonly SubmitParams[];
	readonly fires: readonly { readonly fireId: string; readonly kind: string; readonly payload: unknown }[];
	readonly controls: readonly ControlParams[];
	readonly answers: readonly InteractionAnswerParams[];
	readonly deliveries: readonly DeliveryRecord[];
	readonly interactions: readonly InteractionRecord[];
	readonly attachments: ReadonlyMap<string, Uint8Array>;
	/** How many uploads actually reached the endpoint. A refusal made locally must leave this at zero. */
	readonly attachmentPosts: () => number;
	/** How many keepalives this mason answered. A refused ping is not an answered one. */
	readonly pings: () => number;
	readonly connections: number;
	readonly session: HelloResult | undefined;
	readonly connected: boolean;
	start(): void;
	stop(): void;
	/** Drop the socket the way a network failure would. The connector's reconnect is what recovers. */
	kill(reason?: string): void;
	/** Lose the next delivery's acknowledgement, without losing the send. */
	loseNextAck(): void;
	/** Spend a budget class, so the next call in it is refused with `retryAfterMs`. */
	exhaust(budget: "submissions" | "fires" | "controls" | "attachments"): void;
	deliver(params: Omit<DeliveryFinalParams, "seq"> & { readonly seq?: number }): Promise<DeliveryAck | undefined>;
	startDelivery(params: Omit<DeliveryFinalParams, "seq"> & { readonly seq?: number }): void;
	deltaDelivery(params: {
		readonly deliveryId: string;
		readonly blocks: DeliveryFinalParams["blocks"];
		readonly seq?: number;
	}): void;
	requestInteraction(params: InteractionRequestParams): Promise<InteractionAck | undefined>;
	snapshot(params: Omit<StateSnapshotParams, "seq"> & { readonly seq?: number }): void;
	delta(params: Omit<StateDeltaParams, "seq"> & { readonly seq?: number }): void;
}

const DEFAULT_LIMITS: Limits = {
	submissionsPerMinute: 60,
	firesPerMinute: 6,
	controlsPerMinute: 6,
	attachmentsPerMinute: 30,
	attachmentBytes: 1_048_576,
	attachmentTtlMs: 3_600_000,
};

export function createFakeMason(options: FakeMasonOptions = {}): FakeMason {
	const now = options.now ?? Date.now;
	const connector = options.connector ?? "fake";
	const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
	const capabilities = options.capabilities ?? ["text"];
	const log: Recorded[] = [];
	const submissions: SubmitParams[] = [];
	const fires: Array<{ fireId: string; kind: string; payload: unknown }> = [];
	const controls: ControlParams[] = [];
	const answers: InteractionAnswerParams[] = [];
	const deliveries: DeliveryRecord[] = [];
	const interactions: InteractionRecord[] = [];
	const attachments = new Map<string, Uint8Array>();
	let uploads = 0;
	let answeredPings = 0;
	const seen = new Set<string>();
	const budgets = new Map<string, number>();
	const spent = new Set<string>();

	let peer: RpcPeer | undefined;
	let session: HelloResult | undefined;
	let connections = 0;
	let seq = 0;
	let started = false;
	let loseAck = false;
	let contentCounter = 0;

	const mason: FakeMason = {
		url: "ws://fake-mason/api/connector",
		link,
		fetch,
		log,
		submissions,
		fires,
		controls,
		answers,
		deliveries,
		interactions,
		attachments,
		attachmentPosts: () => uploads,
		pings: () => answeredPings,
		get connections() {
			return connections;
		},
		get session() {
			return session;
		},
		get connected() {
			return peer?.open === true;
		},
		start() {
			started = true;
		},
		stop() {
			started = false;
			peer?.close("the fake mason stopped");
			peer = undefined;
		},
		kill(reason = "network failure") {
			peer?.close(reason);
			peer = undefined;
		},
		loseNextAck() {
			loseAck = true;
		},
		exhaust(budget) {
			spent.add(budget);
		},
		deliver,
		startDelivery,
		deltaDelivery,
		requestInteraction,
		snapshot,
		delta,
	};
	return mason;

	function link(): Link {
		const [mine, theirs] = linkPair();
		attach(mine);
		return theirs;
	}

	function attach(link: Link): void {
		const next = new RpcPeer(
			link,
			{
				request: (method, params) => inbound(method, params),
				notification: (method, params) => {
					log.push({ at: now(), direction: "in", method, params });
				},
				closed: () => {
					peer = undefined;
				},
			},
			{ timeoutMs: 5_000 },
		);
		peer = next;
		connections += 1;
		// After the connector has had a turn of the loop to install its own listener: a real socket has the same order,
		// where the far end cannot deliver anything into a connection that has not finished being established.
		if (started) setTimeout(() => void replay(), 0);
	}

	async function replay(): Promise<void> {
		for (const record of deliveries) {
			if (record.ack !== undefined || record.sending === true) continue;
			await sendDelivery(record);
		}
		for (const record of interactions) {
			if (record.ack !== undefined || record.sending === true) continue;
			await sendInteraction(record);
		}
	}

	async function inbound(method: string, params: unknown): Promise<unknown> {
		log.push({ at: now(), direction: "in", method, params });
		switch (method) {
			case METHOD.hello:
				return hello(params as HelloRequest);
			case METHOD.submit:
				return submit(params as SubmitParams);
			case METHOD.fire:
				return fire(
					params as {
						fireId: string;
						kind: string;
						payload: unknown;
						origin?: { externalConversationId: string };
					},
				);
			case METHOD.control:
				return control(params as ControlParams);
			case METHOD.interactionAnswer:
				return answer(params as InteractionAnswerParams);
			case METHOD.stateSubscribe:
				return subscribe(params as { scopes: string[]; since?: number });
			case METHOD.ping:
				answeredPings += 1;
				return { at: now() };
			default:
				throw refusal(ERROR_CODE.invalidRequest, `${method} is not a method mason answers`);
		}
	}

	function hello(request: HelloRequest): HelloResult {
		const protocol = options.protocol ?? { major: PROTOCOL_MAJOR, minors: [PROTOCOL_MINOR] };
		if (request.protocol.major !== protocol.major) {
			throw refusal(
				ERROR_CODE.protocolMismatch,
				`this mason speaks protocol major ${protocol.major} and the connector speaks ${request.protocol.major}`,
			);
		}
		const granted = mutableGrants(options.granted);
		const inactive: Array<{ face: FaceName; reason: string }> = [];
		const faces: {
			user?: { actors: ExternalActor[]; conversations: ExternalConversation[]; capabilities: Capability[] };
			tools?: { url: string };
			events?: { hooks: Record<string, string> };
		} = {};

		if (request.faces.user !== undefined) {
			if (granted.user === undefined) {
				inactive.push({ face: "user", reason: "the entry grants no user face" });
			} else {
				const owner = granted.user.owner;
				const advertised = request.faces.user.actors ?? [];
				const matched = advertised.filter((actor) => actor.externalActorId === owner);
				faces.user = {
					actors: owner === undefined ? [] : matched,
					conversations: granted.user.conversations ?? [],
					capabilities: intersect(capabilities, granted.user.capabilities ?? capabilities),
				};
			}
		}
		if (request.faces.tools !== undefined) {
			if (granted.tools === undefined)
				inactive.push({ face: "tools", reason: "the entry declares no MCP endpoint" });
			else faces.tools = { url: granted.tools.url };
		}
		if (request.faces.events !== undefined) {
			if (granted.events === undefined) {
				inactive.push({ face: "events", reason: "the entry declares no trigger" });
			} else {
				faces.events = { hooks: granted.events };
				const unknown = (request.faces.events.kinds ?? []).filter(
					(kind) => !Object.hasOwn(granted.events ?? {}, kind),
				);
				if (unknown.length > 0) {
					inactive.push({ face: "events", reason: `no hook is configured for ${unknown.join(", ")}` });
				}
			}
		}

		const negotiated: HelloResult = {
			protocol: { major: protocol.major, minors: [protocol.minors?.[0] ?? 0] },
			connector,
			faces: faces as HelloResult["faces"],
			...(inactive.length === 0 ? {} : { inactive }),
			capabilities: faces.user === undefined ? [] : faces.user.capabilities,
			limits,
		};
		session = negotiated;
		return negotiated;
	}

	function submit(params: SubmitParams): { accepted: boolean; id: string; entryId?: string; duplicate?: boolean } {
		spend("submissions", limits.submissionsPerMinute);
		const granted = options.granted?.user;
		if (session?.faces.user === undefined || granted === undefined) {
			throw refusal(ERROR_CODE.faceNotGranted, "this connector has no user face");
		}
		// One rule, stated once: the owner's actor is the person mason works for, an absent actor is a message nobody
		// signed, and any other actor is a stranger.
		const actor = params.actor;
		if (actor !== undefined && actor.externalActorId !== granted.owner) {
			throw refusal(ERROR_CODE.actorUnknown, `${actor.externalActorId} is not the actor this entry calls its owner`);
		}
		const conversation = params.origin.externalConversationId;
		if (!granted.conversations?.some((known) => known.externalConversationId === conversation)) {
			throw refusal(ERROR_CODE.conversationNotPermitted, `${conversation} is not a permitted room`);
		}
		const key = `submission:${params.submissionId}`;
		if (seen.has(key)) return { accepted: true, id: params.submissionId, duplicate: true };
		seen.add(key);
		submissions.push(params);
		return { accepted: true, id: params.submissionId, entryId: `e-${submissions.length}` };
	}

	function fire(params: {
		fireId: string;
		kind: string;
		payload: unknown;
		origin?: { externalConversationId: string };
	}) {
		spend("fires", limits.firesPerMinute);
		const hooks = session?.faces.events?.hooks;
		if (hooks === undefined) throw refusal(ERROR_CODE.faceNotGranted, "this connector has no events face");
		if (!Object.hasOwn(hooks, params.kind)) {
			throw refusal(ERROR_CODE.kindNotPermitted, `${params.kind} fires no hook on this entry`);
		}
		const key = `fire:${params.fireId}`;
		if (seen.has(key)) return { accepted: true, id: params.fireId, duplicate: true };
		seen.add(key);
		fires.push({ fireId: params.fireId, kind: params.kind, payload: params.payload });
		return { accepted: true, id: params.fireId, entryId: `e-${fires.length}` };
	}

	function control(params: ControlParams) {
		spend("controls", limits.controlsPerMinute);
		if (!["stop", "compact", "clear", "status"].includes(params.op)) {
			throw refusal(ERROR_CODE.invalidRequest, `${params.op} is not a control mason knows`);
		}
		controls.push(params);
		return {
			handled: true,
			op: params.op,
			reply: params.op === "status" ? "idle, 0 queued" : `the ${params.op} was taken`,
			...(params.op === "status" ? { status: { runStatus: "idle", queued: 0 } } : {}),
		};
	}

	function answer(params: InteractionAnswerParams): InteractionAnswerResult {
		const record = interactions.find((entry) => entry.permissionId === params.permissionId);
		if (record === undefined) {
			throw refusal(ERROR_CODE.unknownPermission, `${params.permissionId} is not pending`);
		}
		if (record.answer !== undefined) return { settled: false, reason: "already settled" };
		if (!["allow", "deny"].includes(params.answer)) {
			throw refusal(ERROR_CODE.invalidRequest, `${params.answer} is not an answer`);
		}
		answers.push(params);
		record.answer = { settled: true };
		record.answerParams = params;
		return { settled: true };
	}

	function subscribe(params: { scopes: string[]; since?: number }): StateSubscribeResult {
		const allowed = options.granted?.state ?? [];
		const refused = params.scopes.filter((scope) => !allowed.includes(scope));
		if (refused.length > 0) {
			throw refusal(ERROR_CODE.scopeNotGranted, `${refused.join(", ")} is not a scope this entry grants`);
		}
		return {
			scopes: params.scopes as StateSubscribeResult["scopes"],
			seq: params.since ?? 0,
			...(params.since === undefined ? {} : { resumed: true }),
		};
	}

	function spend(budget: string, perMinute: number): void {
		if (spent.has(budget)) {
			spent.delete(budget);
			throw refusal(ERROR_CODE.rateLimited, `this connector has spent its ${budget} budget for the minute`, {
				retryable: true,
				retryAfterMs: 1_000,
			});
		}
		const used = budgets.get(budget) ?? 0;
		if (used >= perMinute) {
			throw refusal(ERROR_CODE.rateLimited, `this connector has spent its ${budget} budget for the minute`, {
				retryable: true,
				retryAfterMs: 1_000,
			});
		}
		budgets.set(budget, used + 1);
	}

	function nextSeq(): number {
		seq += 1;
		return seq;
	}

	async function deliver(
		params: Omit<DeliveryFinalParams, "seq"> & { readonly seq?: number },
	): Promise<DeliveryAck | undefined> {
		const record: DeliveryRecord = {
			deliveryId: params.deliveryId,
			params: { ...params, seq: params.seq ?? nextSeq() } as DeliveryFinalParams,
			sentAt: now(),
			attempts: 0,
		};
		deliveries.push(record);
		return sendDelivery(record);
	}

	async function sendDelivery(record: DeliveryRecord): Promise<DeliveryAck | undefined> {
		if (peer === undefined || !peer.open || record.sending === true) return undefined;
		record.sending = true;
		record.attempts += 1;
		log.push({ at: now(), direction: "out", method: METHOD.deliveryFinal, params: record.params });
		try {
			if (loseAck) {
				loseAck = false;
				record.lostAck = true;
				peer.sendWithoutWaiting(METHOD.deliveryFinal, record.params);
				return undefined;
			}
			const ack = (await peer.call(METHOD.deliveryFinal, record.params)) as DeliveryAck;
			record.ack = ack;
			return ack;
		} catch (error) {
			if (error instanceof PeerError) {
				record.ack = { status: "rejected", detail: error.message };
				return record.ack;
			}
			return undefined;
		} finally {
			record.sending = false;
		}
	}

	function startDelivery(params: Omit<DeliveryFinalParams, "seq"> & { readonly seq?: number }): void {
		const seqNow = params.seq ?? nextSeq();
		log.push({ at: now(), direction: "out", method: METHOD.deliveryStart, params: { ...params, seq: seqNow } });
		peer?.notify(METHOD.deliveryStart, { ...params, seq: seqNow });
	}

	function deltaDelivery(params: {
		readonly deliveryId: string;
		readonly blocks: DeliveryFinalParams["blocks"];
		readonly seq?: number;
	}): void {
		const seqNow = params.seq ?? nextSeq();
		log.push({ at: now(), direction: "out", method: METHOD.deliveryDelta, params: { ...params, seq: seqNow } });
		peer?.notify(METHOD.deliveryDelta, { ...params, seq: seqNow });
	}

	async function requestInteraction(params: InteractionRequestParams): Promise<InteractionAck | undefined> {
		const record: InteractionRecord = { permissionId: params.permissionId, params };
		interactions.push(record);
		return sendInteraction(record);
	}

	async function sendInteraction(record: InteractionRecord): Promise<InteractionAck | undefined> {
		if (peer === undefined || !peer.open || record.sending === true) return undefined;
		record.sending = true;
		log.push({ at: now(), direction: "out", method: METHOD.interactionRequest, params: record.params });
		try {
			const ack = (await peer.call(METHOD.interactionRequest, record.params)) as InteractionAck;
			record.ack = ack;
			return ack;
		} catch (error) {
			if (error instanceof PeerError) {
				record.ack = { delivered: false, detail: error.message };
				return record.ack;
			}
			return undefined;
		} finally {
			record.sending = false;
		}
	}

	function snapshot(params: Omit<StateSnapshotParams, "seq"> & { readonly seq?: number }): void {
		const seqNow = params.seq ?? nextSeq();
		log.push({ at: now(), direction: "out", method: METHOD.stateSnapshot, params: { ...params, seq: seqNow } });
		peer?.notify(METHOD.stateSnapshot, { ...params, seq: seqNow });
	}

	function delta(params: Omit<StateDeltaParams, "seq"> & { readonly seq?: number }): void {
		const seqNow = params.seq ?? nextSeq();
		log.push({ at: now(), direction: "out", method: METHOD.stateDelta, params: { ...params, seq: seqNow } });
		peer?.notify(METHOD.stateDelta, { ...params, seq: seqNow });
	}

	/** The transfer endpoint, served in memory: the same headers and statuses mason's route answers with. */
	async function fetch(input: string, init: RequestInit = {}): Promise<Response> {
		const url = new URL(input);
		const credential = (init.headers as Record<string, string> | undefined)?.authorization;
		if (credential !== "Bearer test-credential") {
			return new Response(JSON.stringify({ code: ERROR_CODE.notAuthenticated, message: "bad credential" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname === "/api/connector/attachments" && init.method === "POST") {
			if (spent.has("attachments")) {
				spent.delete("attachments");
				return new Response(
					JSON.stringify({
						code: ERROR_CODE.rateLimited,
						message: "this connector has spent its attachments budget",
						retryable: true,
						retryAfterMs: 1_000,
					}),
					{ status: 429, headers: { "content-type": "application/json" } },
				);
			}
			uploads += 1;
			const body = new Uint8Array(init.body as ArrayBuffer);
			const cap = limits.attachmentBytes ?? DEFAULT_LIMITS.attachmentBytes ?? 0;
			if (body.byteLength > cap) {
				return new Response(
					JSON.stringify({ code: ERROR_CODE.invalidRequest, message: `that file is over ${cap} bytes` }),
					{ status: 413, headers: { "content-type": "application/json" } },
				);
			}
			const contentId = `content-${++contentCounter}`;
			attachments.set(contentId, body);
			return new Response(JSON.stringify({ contentId, size: body.byteLength }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		const prefix = "/api/connector/attachments/";
		if (url.pathname.startsWith(prefix) && (init.method ?? "GET") === "GET") {
			const id = decodeURIComponent(url.pathname.slice(prefix.length));
			const bytes = attachments.get(id);
			if (bytes === undefined) {
				return new Response(JSON.stringify({ code: ERROR_CODE.invalidRequest, message: "no such content" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(bytes as unknown as BodyInit, {
				status: 200,
				headers: { "content-type": "application/octet-stream", "x-mason-filename": encodeURIComponent("file.bin") },
			});
		}
		return new Response("not found", { status: 404 });
	}
}

/** The grants as an object this file may fill in. The options are readonly because a caller must not edit them later. */
function mutableGrants(input: FakeMasonGrants | undefined): {
	user?: {
		owner?: string;
		conversations: ExternalConversation[];
		capabilities: Capability[];
	};
	tools?: { url: string };
	events?: Record<string, string>;
	state?: readonly string[];
} {
	if (input === undefined) return {};
	return {
		...(input.user === undefined
			? {}
			: {
					user: {
						...(input.user.owner === undefined ? {} : { owner: input.user.owner }),
						conversations: [...(input.user.conversations ?? [])],
						capabilities: [...(input.user.capabilities ?? [])],
					},
				}),
		...(input.tools === undefined ? {} : { tools: { url: input.tools.url } }),
		...(input.events === undefined ? {} : { events: { ...input.events } }),
		...(input.state === undefined ? {} : { state: input.state }),
	};
}

function refusal(code: ProtocolErrorData["code"], message: string, extra: Partial<ProtocolErrorData> = {}): PeerError {
	const data: ProtocolErrorData = { code, message, ...extra };
	const frame = protocolFailure(null, data);
	return new PeerError("<fake-mason>", frame.error.code, message, data);
}

function intersect(ours: readonly Capability[], theirs: readonly Capability[]): Capability[] {
	return ours.filter((capability) => theirs.includes(capability));
}
