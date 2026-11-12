/**
 * A fake mason, as a Chord host: the *server* half of the protocol, implemented for real.
 *
 * It is deliberately not a mock. It enforces the grant, the one owner actor, the budgets and the deduplication, because
 * a mock that says yes to everything proves nothing about a connector that has to survive a no.
 * Both hosts run over a real Chord link (`memoryLinkPair`), so what a case exercises is the protocol, not a stand-in.
 *
 * What it is not: mason. The conformance suite checks the connector's side of the contract, and a real mason checks
 * mason's. Both are needed, and neither substitutes for the other.
 */
import { createHost, type Host, type Link, memoryLinkPair } from "@earendil-works/chord";
import {
	type ConnectorRef,
	type ControlOp,
	type ControlResult,
	connectorHost,
	type DeliveryAck,
	ERROR_CODE,
	MasonConnector,
	MasonPeer,
	masonError,
	type Session,
	SessionSchema,
} from "mason-protocol";
import type { Fetcher } from "../attachments.ts";

/** What the operator granted: the ceiling every case is measured against. */
export interface FakeMasonGrants {
	/**
	 * The one external actor id mason accepts as the person it works for. Any other is refused. `null` is the entry that
	 * grants no `user` face at all: it may raise events, write notices and answer controls, and it may not carry words.
	 */
	readonly owner?: string | null;
	/** The event kinds this entry's grant names. A kind absent from this list is refused. */
	readonly kinds?: readonly string[];
	readonly commands?: readonly ControlOp[];
}

export interface DeliveryRecord {
	readonly deliveryId: string;
	readonly args: { readonly deliveryId: string; readonly blocks: readonly unknown[]; readonly ref?: string };
	sentAt: number;
	ack?: DeliveryAck;
	attempts: number;
	/** A call is on the link right now. Replay must leave it alone: a record still in flight is not one a reconnect lost. */
	sending?: boolean;
}

export interface FakeMasonOptions {
	readonly connector?: string;
	readonly granted?: FakeMasonGrants;
	readonly limits?: Partial<Session["limits"]>;
	readonly now?: () => number;
}

export interface FakeMason {
	readonly link: (url: string, init: { readonly credential: string }) => Link;
	readonly fetch: Fetcher;
	readonly submissions: ReadonlyArray<{ appendId: string; text: string; ref?: string; mode?: string }>;
	readonly events: ReadonlyArray<{ appendId: string; kind: string; payload: unknown }>;
	readonly notices: readonly string[];
	readonly controls: ReadonlyArray<{ op: string }>;
	readonly refusals: readonly string[];
	readonly deliveries: readonly DeliveryRecord[];
	readonly attachments: ReadonlyMap<string, Uint8Array>;
	/** How many uploads actually reached the endpoint. A refusal made locally must leave this at zero. */
	readonly attachmentPosts: () => number;
	readonly connections: number;
	readonly connected: boolean;
	start(): void;
	stop(): void;
	/** Drop the link the way a network failure would. The connector's reconnect is what recovers. */
	kill(reason?: string): void;
	/** Lose the next delivery's acknowledgement, without losing the send. */
	loseNextAck(): void;
	/** Spend a budget class, so the next call in it is refused. */
	exhaust(budget: "submissions" | "events" | "controls" | "attachments"): void;
	deliver(params: {
		readonly deliveryId: string;
		readonly blocks: readonly unknown[];
		readonly ref?: string;
	}): Promise<DeliveryAck | undefined> | DeliveryAck | undefined;
}

const DEFAULT_LIMITS: Session["limits"] = {
	submissionsPerMinute: 60,
	firesPerMinute: 6,
	controlsPerMinute: 6,
	attachmentsPerMinute: 30,
	attachmentBytes: 1_048_576,
	attachmentTtlMs: 3_600_000,
};

export function createFakeMason(options: FakeMasonOptions = {}): FakeMason {
	const now = options.now ?? Date.now;
	const name = options.connector ?? "fake";
	const granted = options.granted ?? {};
	const limits: Session["limits"] = { ...DEFAULT_LIMITS, ...options.limits };
	const submissions: Array<{ appendId: string; text: string; ref?: string; mode?: string }> = [];
	const events: Array<{ appendId: string; kind: string; payload: unknown }> = [];
	const notices: string[] = [];
	const controls: Array<{ op: string }> = [];
	const refusals: string[] = [];
	const deliveries: DeliveryRecord[] = [];
	const attachments = new Map<string, Uint8Array>();
	const seen = new Set<string>();
	const spent = new Set<string>();
	const budgets = new Map<string, number>();
	let uploads = 0;
	let contentCounter = 0;
	let connections = 0;
	let started = false;
	/** Armed by `loseNextAck`: the next delivery's answer is dropped on its way back. */
	let armDrop = false;
	let dropResult = false;
	let mine: Link | undefined;
	/** The call a delivery is on the wire with, so a replay waits for it instead of starting a second one. */
	const inFlight = new Map<string, Promise<DeliveryAck | undefined>>();
	/** Which call owns a delivery id: an abandoned one must not delete the entry a resend put there. */
	const owner = new Map<string, number>();
	let callSeq = 0;

	const session: Session = {
		protocol: 1,
		commands: [...(granted.commands ?? [])],
		kinds: [...(granted.kinds ?? [])],
		limits,
	};

	const host: Host<{ connector: string }> = createHost({
		name: "mason",
		self: { connector: "mason" },
		onError: (error) => refusals.push(describe(error)),
	});

	host.serve(MasonPeer, (_input, _principal, self) => ({
		variant: "default",
		session: self.state("session", SessionSchema, session),
		append: async (args: unknown) => append(args as never),
		control: async (args: unknown) => control(args as never),
	}));

	const mason: FakeMason = {
		link,
		fetch,
		submissions,
		events,
		notices,
		controls,
		refusals,
		deliveries,
		attachments,
		attachmentPosts: () => uploads,
		get connections() {
			return connections;
		},
		get connected() {
			return mine !== undefined;
		},
		start() {
			started = true;
		},
		stop() {
			started = false;
			mine?.close("the fake mason stopped");
			mine = undefined;
			void host.close();
		},
		kill(reason = "network failure") {
			mine?.close(reason);
			mine = undefined;
			// Whatever was on the wire when it died is unknown, not running: the record waits for the resend a reconnect
			// makes, and nothing here waits on a call whose answer cannot come.
			inFlight.clear();
			owner.clear();
			for (const record of deliveries) record.sending = false;
		},
		loseNextAck() {
			armDrop = true;
		},
		exhaust(budget) {
			spent.add(budget);
		},
		deliver,
	};
	return mason;

	function link(): Link {
		const [theirs, ours] = memoryLinkPair();
		mine = ours;
		connections += 1;
		host.accept(ours, { principal: { connector: name }, kind: "host", name: connectorHost(name) });
		// After the connector has had the link to say hello on: a child host that has not announced itself yet is not
		// addressable, and a `get` that arrives first waits for a synced connection rather than failing.
		if (started) {
			setTimeout(() => void replay(), 25);
			setTimeout(() => void replay(), 150);
		}
		return droppingAcks(theirs);
	}

	/** Drop the answer to the next delivery, which is the only way a lost acknowledgement is knowable. */
	function droppingAcks(link: Link): Link {
		return {
			get closed() {
				return link.closed;
			},
			send(frame) {
				if (frame.t === "result" && dropResult) {
					dropResult = false;
					return undefined;
				}
				return link.send(frame);
			},
			receive(handler) {
				link.receive(handler);
			},
			onClose(handler) {
				link.onClose(handler);
			},
			close(reason) {
				link.close(reason);
			},
		};
	}

	async function replay(): Promise<void> {
		for (const record of deliveries) {
			if (record.ack !== undefined) continue;
			const pending = inFlight.get(record.deliveryId);
			if (pending !== undefined) await pending.catch(() => undefined);
			if (record.ack !== undefined) continue;
			await send(record);
		}
	}

	async function append(args: {
		type: "submission" | "event" | "notice";
		appendId: string;
		content?: ReadonlyArray<{ type: string; text?: string }>;
		kind?: string;
		payload?: unknown;
		text?: string;
		origin?: { ref: string; actor?: { id: string } };
		mode?: string;
	}) {
		if (args.type === "submission") {
			// The user face is the first ceiling, as it is at the door: an entry that grants no `user` may not carry words at
			// all, and it spends nothing to be told so.
			if (granted.owner === null) {
				throw masonError(
					ERROR_CODE.faceNotGranted,
					"this entry holds no user grant: it may not carry a person's words",
				);
			}
			// The owner rule the real door applies: an actor that is not the granted one is refused, and so is any actor
			// when the grant names none. The conformance suite's forged-actor case is this line, which is why it is one.
			const actor = args.origin?.actor?.id;
			if (actor !== undefined && actor !== granted.owner) {
				throw masonError(ERROR_CODE.actorUnknown, `"${actor}" is not the actor this entry calls its owner`);
			}
		}
		if (args.type === "event" && !(granted.kinds ?? []).includes(args.kind ?? "")) {
			throw masonError(ERROR_CODE.kindNotPermitted, `"${args.kind}" is not a kind this entry's grant names`);
		}
		// Dedupe first, and free: the door answers a resend before it charges anything, and a retry that cost a sender its
		// minute would fail twice. A notice and a submission both spend the same budget, because both put words in the
		// transcript; an event has its own.
		const key = `${args.type}:${args.appendId}`;
		if (seen.has(key)) return { outcome: "duplicate" as const };
		if (args.type === "event") spend("events", limits.firesPerMinute);
		else spend("submissions", limits.submissionsPerMinute);
		seen.add(key);
		if (args.type === "submission") {
			const text = (args.content ?? [])
				.flatMap((block) => (block.type === "text" || block.type === "markdown" ? [block.text ?? ""] : []))
				.join("");
			submissions.push({
				appendId: args.appendId,
				text,
				...(args.origin === undefined ? {} : { ref: args.origin.ref }),
				...(args.mode === undefined ? {} : { mode: args.mode }),
			});
		}
		if (args.type === "event") events.push({ appendId: args.appendId, kind: args.kind ?? "", payload: args.payload });
		if (args.type === "notice") notices.push(args.text ?? "");
		return { outcome: "accepted" as const, entryId: `e-${seen.size}` };
	}

	function control(args: { op: string }): ControlResult {
		spend("controls", limits.controlsPerMinute);
		if (!(granted.commands ?? []).includes(args.op as ControlOp)) {
			throw masonError(ERROR_CODE.invalidRequest, `this entry declares no "${args.op}" command`);
		}
		controls.push({ op: args.op });
		return {
			handled: true,
			op: args.op,
			reply: args.op === "status" ? "idle, 0 queued" : `the ${args.op} was taken`,
			...(args.op === "status" ? { status: { runStatus: "idle" } } : {}),
		};
	}

	function spend(budget: string, perMinute: number): void {
		if (spent.delete(budget)) {
			throw masonError(ERROR_CODE.rateLimited, `this connector has spent its ${budget} budget for the minute`);
		}
		const used = budgets.get(budget) ?? 0;
		if (used >= perMinute) {
			throw masonError(ERROR_CODE.rateLimited, `this connector has spent its ${budget} budget for the minute`);
		}
		budgets.set(budget, used + 1);
	}

	/**
	 * One delivery. Mason re-`get`s the object every time: a held reference goes `gone` when the link drops, so holding
	 * one would be a map from connector to a reference that is either live or a stale error.
	 */
	function deliver(params: {
		readonly deliveryId: string;
		readonly blocks: readonly unknown[];
		readonly ref?: string;
	}): Promise<DeliveryAck | undefined> | DeliveryAck | undefined {
		const record: DeliveryRecord = {
			deliveryId: params.deliveryId,
			args: params as never,
			sentAt: now(),
			attempts: 0,
		};
		deliveries.push(record);
		return send(record);
	}

	function send(record: DeliveryRecord): Promise<DeliveryAck | undefined> | undefined {
		if (mine === undefined) return undefined;
		const running = inFlight.get(record.deliveryId);
		if (running !== undefined) return running;
		record.sending = true;
		record.attempts += 1;
		const lose = armDrop;
		armDrop = false;
		if (lose) dropResult = true;
		const seq = ++callSeq;
		owner.set(record.deliveryId, seq);
		const call = (async (): Promise<DeliveryAck | undefined> => {
			try {
				// Mason re-`get`s the object every time: a held reference goes `gone` when the link drops. Bounded,
				// because a connector that has not finished its handshake would otherwise hold the outbox open.
				const ref = (await withDeadline(
					host.get(MasonConnector, { connector: name }),
					DELIVERY_WAIT_MS,
				)) as unknown as ConnectorRef;
				const ack = await withDeadline(Promise.resolve(ref.deliver(record.args as never)), DELIVERY_WAIT_MS);
				record.ack = ack as DeliveryAck;
				return record.ack;
			} catch (error) {
				refusals.push(describe(error));
				return undefined;
			} finally {
				record.sending = false;
				if (owner.get(record.deliveryId) === seq) {
					owner.delete(record.deliveryId);
					inFlight.delete(record.deliveryId);
				}
			}
		})();
		inFlight.set(record.deliveryId, call);
		if (lose) {
			// The answer is dropped and the call is left running: the state a lost frame cannot be distinguished from.
			void call;
			return undefined;
		}
		return call;
	}

	/** The transfer endpoint, served in memory: the same headers and statuses mason's route answers with. */
	async function fetch(input: string, init: RequestInit = {}): Promise<Response> {
		const url = new URL(input);
		const credential = (init.headers as Record<string, string> | undefined)?.authorization;
		if (credential !== "Bearer test-credential") {
			return json(401, { code: ERROR_CODE.notAuthenticated, message: "bad credential" });
		}
		if (url.pathname === "/api/connector/attachments" && init.method === "POST") {
			if (spent.delete("attachments")) {
				return json(429, { code: ERROR_CODE.rateLimited, message: "this connector has spent its uploads" });
			}
			uploads += 1;
			const body = new Uint8Array(init.body as ArrayBuffer);
			if (body.byteLength > limits.attachmentBytes) {
				return json(413, { code: ERROR_CODE.invalidRequest, message: "that file is over the cap" });
			}
			const contentId = `content-${++contentCounter}`;
			attachments.set(contentId, body);
			return json(200, { contentId, size: body.byteLength });
		}
		return json(404, { code: ERROR_CODE.invalidRequest, message: "not found" });
	}
}

/** How long the fake mason waits for a connector to answer before the delivery is left owed. */
const DELIVERY_WAIT_MS = 400;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
