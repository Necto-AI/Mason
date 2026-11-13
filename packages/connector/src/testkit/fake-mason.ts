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
	type ControlOp,
	type ControlResult,
	type ConversationState,
	ConversationStateSchema,
	connectorHost,
	ERROR_CODE,
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
	 * grants no `user` face at all: it may raise events and answer controls, and it may not carry words.
	 */
	readonly owner?: string | null;
	/** The event kinds this entry's grant names. A kind absent from this list is refused. */
	readonly kinds?: readonly string[];
	readonly commands?: readonly ControlOp[];
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
	readonly controls: ReadonlyArray<{ op: string }>;
	readonly refusals: readonly string[];
	readonly attachments: ReadonlyMap<string, Uint8Array>;
	/** How many uploads actually reached the endpoint. A refusal made locally must leave this at zero. */
	readonly attachmentPosts: () => number;
	readonly connections: number;
	readonly connected: boolean;
	stop(): void;
	/** Drop the link the way a network failure would. The connector's reconnect is what recovers. */
	kill(reason?: string): void;
	/** Spend a budget class, so the next call in it is refused. */
	exhaust(budget: "submissions" | "events" | "controls" | "attachments"): void;
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
	const name = options.connector ?? "fake";
	const granted = options.granted ?? {};
	const limits: Session["limits"] = { ...DEFAULT_LIMITS, ...options.limits };
	const submissions: Array<{ appendId: string; text: string; ref?: string; mode?: string }> = [];
	const events: Array<{ appendId: string; kind: string; payload: unknown }> = [];
	const controls: Array<{ op: string }> = [];
	const refusals: string[] = [];
	const attachments = new Map<string, Uint8Array>();
	const seen = new Set<string>();
	const spent = new Set<string>();
	const budgets = new Map<string, number>();
	let uploads = 0;
	let contentCounter = 0;
	let connections = 0;
	let mine: Link | undefined;

	const session: Session = {
		protocol: 1,
		commands: [...(granted.commands ?? [])],
		kinds: [...(granted.kinds ?? [])],
		limits,
	};
	/** A conversation nothing has happened in: revision 0, no rows, no queue, no run. */
	const emptyConversation: ConversationState = {
		revision: 0,
		transcript: [],
		queue: [],
		run: "idle",
		busy: false,
		transitions: [],
	};

	const host: Host<{ connector: string }> = createHost({
		name: "mason",
		self: { connector: "mason" },
		onError: (error) => refusals.push(describe(error)),
	});

	host.serve(MasonPeer, (_input, _principal, self) => ({
		variant: "default",
		session: self.state("session", SessionSchema, session),
		// The contract declares the conversation and mason always serves it, so the fake does too. The connector SDK reads
		// `session`; a case that renders the conversation belongs with the client that renders it, not with the connector.
		conversation: self.state("conversation", ConversationStateSchema, emptyConversation),
		append: async (args: unknown) => append(args as never),
		control: async (args: unknown) => control(args as never),
	}));

	const mason: FakeMason = {
		link,
		fetch,
		submissions,
		events,
		controls,
		refusals,
		attachments,
		attachmentPosts: () => uploads,
		get connections() {
			return connections;
		},
		get connected() {
			return mine !== undefined;
		},
		stop() {
			mine?.close("the fake mason stopped");
			mine = undefined;
			void host.close();
		},
		kill(reason = "network failure") {
			mine?.close(reason);
			mine = undefined;
		},
		exhaust(budget) {
			spent.add(budget);
		},
	};
	return mason;

	function link(): Link {
		const [theirs, ours] = memoryLinkPair();
		mine = ours;
		connections += 1;
		host.accept(ours, { principal: { connector: name }, kind: "host", name: connectorHost(name) });
		return theirs;
	}

	async function append(args: {
		type: "submission" | "event";
		appendId: string;
		content?: ReadonlyArray<{ type: string; text?: string }>;
		kind?: string;
		payload?: unknown;
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
		// minute would fail twice. A submission spends the submission budget; an event has its own.
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
		events.push({ appendId: args.appendId, kind: args.kind ?? "", payload: args.payload });
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

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
