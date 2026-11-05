/**
 * The permission gateway: one decision in front of every tool call, and a question a person answers when it says "ask".
 *
 * ## One gate, not one per tool
 *
 * The gate is a `beforeTool` hook (`pi-durable`'s pre-intent hook), which is the only seam that sees a model-issued call
 * and a script's nested call with the same shape — `call.parent` is set for the second — and runs *before* the call's
 * intent is committed. That last part is what makes a pending approval survive a restart: a task that dies while
 * waiting has committed no intent, so recovery runs the hook again, the hook reads the answer that was written down, and
 * only then does the call get an intent and execute. A gate inside `execute()` would have no such promise — an
 * interrupted non-replayable call settles, and an approved effect would never happen.
 *
 * ## What it decides
 *
 * - `reply` to the turn's own origin is allowed. Naming another conversation asks, because sending words elsewhere is
 *   the one delivery decision a person other than the model should make.
 * - `mcp_call` is decided by the tool's own `dev.mason/approval` marker, inside the operator's ceiling: a `deny` rule
 *   refuses, an `ask` rule asks, `required` asks, and `not_required` is allowed only when the operator trusted that
 *   connector's markers or an `allow` rule names the tool. Nothing about the marker is cached: the catalog is asked
 *   afresh, reconnecting a server that dropped first, and a tool nobody can see right now is refused rather than run.
 *   That last rule is the one that makes the gate a gate — a call must never run because mason could not see what the
 *   service says about it, and `mcp_call` reconnects before it executes, so a cache miss is not a "gone".
 * - Everything else mason ships is allowed: the tools are the bot's own body, and gating `bash` is a policy question
 *   (#97, #103), not a marker one.
 *
 * ## The question, and the answer
 *
 * An `ask` writes an `app.permission` entry — durable, so it survives a restart, and visible in the transcript the door
 * reads — and waits. The answer is an `app.permission-answer` entry: `allow`, `deny`, or `cancelled` when `/stop` ended
 * the wait. The first authorized answer settles the request; a later one changes nothing, and there is no "always
 * allow" — standing policy is an administrative act, not a chat button.
 *
 * A request is routed to the surface the turn came from, and is settled either by a device holding the `approve` grant or
 * by the connector's own `owner` actor. There is one authority, not one per name: the credential is the strongest
 * statement of who administers this bot, and the owner actor is the same person speaking through their chat. A request
 * that came through one connector is never settled through another.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
	type Cursor,
	defineExtension,
	type EntryRecord,
	type Extension,
	type HookApi,
	hook,
	ToolTask,
	type Tx,
} from "@earendil-works/pi-durable";
import type { ApprovalMarker, Origin } from "mason-protocol";
import { connectorGrantFor } from "./connectors.ts";
import type { Integration } from "./integrations.ts";
import { MCP_TOOL, type McpCatalog, rediscovery } from "./mcp.ts";
import { type TurnOrigin, turnInputIn, turnOriginOfEntry } from "./replies.ts";

/** One committed question: the record the door sends and the transcript keeps. */
export const PERMISSION_ENTRY_KIND = "app.permission";
/** What came of one question. Written once; every later answer is refused. */
export const PERMISSION_ANSWER_ENTRY_KIND = "app.permission-answer";

/** The two answers a person can give, plus the one the runtime gives when the wait is cancelled. */
export type PermissionOutcome = "allow" | "deny" | "cancelled";

/** The tool being asked about, in the protocol's own shape. */
export interface PermissionTool {
	/** The mason tool: `mcp_call`, or `reply` for a cross-origin delivery. */
	readonly name: string;
	/** The service, when the call reaches one: the entry's name in `integrations.json`. */
	readonly connector?: string;
	/** The service's own name for the operation. */
	readonly tool?: string;
}

/** One pending request, as `app.permission` holds it and `/api/permissions` answers it. */
export interface PermissionRequest {
	readonly permissionId: string;
	readonly tool: PermissionTool;
	readonly arguments: JsonValue | undefined;
	readonly reason: string;
	readonly answers: readonly ("allow" | "deny")[];
	/** Where the turn came from, which is where the question goes. */
	readonly origin?: Origin;
	readonly askedAt: number;
}

/** One answer, as `app.permission-answer` holds it. */
export interface PermissionAnswer {
	readonly permissionId: string;
	readonly answer: PermissionOutcome;
	/** Who answered: a connector's name, `owner` for a device, or `stop` when the runtime cancelled the wait. */
	readonly by?: string;
	readonly at: number;
}

/** What the gate came to for one call. */
export type PermissionDecision =
	| { readonly kind: "allow" }
	| { readonly kind: "deny"; readonly reason: string; readonly tool: PermissionTool }
	| { readonly kind: "ask"; readonly reason: string; readonly tool: PermissionTool };

/** What the catalog answered about one tool, asked before the call was decided. */
export type MarkerReading =
	| { readonly present: true; readonly marker: ApprovalMarker }
	| { readonly present: false; readonly why: string };

/** What the gate is asked, apart from the call itself: the policy in force and what the catalog said about the tool. */
export interface PermissionInputs {
	readonly toolName: string;
	readonly args: Record<string, unknown>;
	readonly origin: TurnOrigin;
	readonly integrations: Record<string, Integration>;
	/**
	 * What the catalog answered about the tool this call would reach, or `undefined` when the call reaches no catalog
	 * tool.
	 *
	 * It is resolved by the caller *before* the decision, from a fresh answer, and that is the whole point: a marker read
	 * out of the last successful listing is a marker a reconnect inside the call itself can refresh away, and a call must
	 * never run because mason could not see what the service says about it.
	 */
	readonly reading?: MarkerReading;
}

/** The operator's rules for one connector's tools. A missing list is no rule; a rule always names a tool as the server does. */
export interface ConnectorPolicy {
	readonly allow: readonly string[];
	readonly ask: readonly string[];
	readonly deny: readonly string[];
}

/**
 * One call's decision, as a pure function of the call, the turn's origin and the operator's configuration.
 *
 * Precedence is the ceiling this exists to be: `deny` beats `ask` beats `allow`, so an operator's tighter rule can never
 * be loosened by a marker, and a marker can never loosen the operator's.
 */
export function decide(inputs: PermissionInputs): PermissionDecision {
	if (inputs.toolName === "mcp_call") return decideMcpCall(inputs);
	if (inputs.toolName === "reply") return decideReply(inputs);
	return { kind: "allow" };
}

function decideMcpCall(inputs: PermissionInputs): PermissionDecision {
	const integration = typeof inputs.args.integration === "string" ? inputs.args.integration : undefined;
	const tool = typeof inputs.args.tool === "string" ? inputs.args.tool : undefined;
	if (integration === undefined || tool === undefined) {
		// Not a call this build understands; validation refuses it before anything runs, so there is nothing to ask about.
		return { kind: "allow" };
	}
	const name = `${integration}/${tool}`;
	const rule = inputs.integrations[integration]?.connector;
	const policy = rule?.policy;
	const subject = { name: MCP_TOOL.call, connector: integration, tool };
	const reading = inputs.reading;
	if (reading === undefined || !reading.present) {
		// Nothing a caller can see, so nothing to weigh: a server that is not answering, or no longer offers the tool, is a
		// call that does not run. Failing closed here is what keeps a `required` marker from being invisible for exactly the
		// moment a reconnect would have hidden it.
		return {
			kind: "deny",
			reason: reading?.why ?? `the gateway has no catalog answer for ${name}: nothing may run until one exists`,
			tool: subject,
		};
	}
	const listed = reading.marker;
	if (matches(policy?.deny, tool)) {
		return { kind: "deny", reason: `the operator denies ${name}`, tool: subject };
	}
	if (matches(policy?.ask, tool)) {
		return { kind: "ask", reason: `the operator requires approval for ${name}`, tool: subject };
	}
	if (listed === "required") {
		return { kind: "ask", reason: `${name} declares that its effect needs approval`, tool: subject };
	}
	if (matches(policy?.allow, tool) || rule?.trustMarkers === true) return { kind: "allow" };
	return {
		kind: "ask",
		reason: `${name} is not marked safe, and this connector's markers are not trusted`,
		tool: subject,
	};
}

function decideReply(inputs: PermissionInputs): PermissionDecision {
	const to = inputs.args.to;
	if (typeof to !== "object" || to === null) return { kind: "allow" };
	const target = to as { connector?: unknown; conversation?: unknown };
	if (typeof target.connector !== "string" || typeof target.conversation !== "string") return { kind: "allow" };
	// A reply that named a destination is a proactive send. Answering the turn's own origin is not: that is the reply the
	// model is told to make — and a fire carries an origin too, so "own" is the carried conversation whatever started
	// the turn, not only the words a connector brought.
	const carried = inputs.origin.kind === "console" ? undefined : inputs.origin.origin;
	if (
		carried !== undefined &&
		carried.connector === target.connector &&
		carried.externalConversationId === target.conversation
	) {
		return { kind: "allow" };
	}
	return {
		kind: "ask",
		reason: `the reply would go to ${target.connector} "${target.conversation}" instead of where the turn came from`,
		tool: { name: "reply", connector: target.connector },
	};
}

/** Whether a rule list names this tool. `*` is the operator writing "every tool on this connector". */
function matches(rules: readonly string[] | undefined, tool: string): boolean {
	if (rules === undefined) return false;
	return rules.includes(tool) || rules.includes("*");
}

/**
 * The surface a pending request may be sent to: where it came from, as long as the entry still grants that conversation.
 *
 * Whoever asked, the question goes back to the chat it was asked in. A request whose conversation the operator has since
 * taken away stays pending in the panel: mason does not send a question to a room it may no longer speak in.
 */
export function surfaceFor(
	request: PermissionRequest,
	integrations: Record<string, Integration>,
): { readonly connector: string; readonly conversation: string } | undefined {
	const carried = request.origin;
	if (carried === undefined) return undefined;
	const live = connectorGrantFor(integrations, carried.connector)?.grant.user;
	if (live === undefined) return undefined;
	const permitted = live.conversations.some(
		(entry) => entry.externalConversationId === carried.externalConversationId,
	);
	return permitted ? { connector: carried.connector, conversation: carried.externalConversationId } : undefined;
}

/**
 * Whether an actor a connector names may answer this request. The owner's own route never asks this.
 *
 * Three refusals, and each is a different wrong answer. A question that came through another connector is not this
 * connector's to settle, because two connectors are two seats. A connector with no `owner` has nobody to answer through
 * it, so the panel is the only way. And a submission actor that is not the owner is a stranger: having spoken buys no
 * authority to approve. What an answer records is the connector itself, which is what the transcript can hold.
 */
export function mayAnswer(
	request: PermissionRequest,
	grant: {
		readonly owner?: string;
		/** The integration this grant belongs to: a question that came through another connector is not this one's. */
		readonly connector: string;
	},
	by: { readonly externalActorId?: string },
): { readonly ok: true; readonly by: string } | { readonly ok: false; readonly reason: string } {
	if (grant.owner === undefined) {
		return { ok: false, reason: "this connector names no owner, so nobody on it may answer" };
	}
	if (request.origin === undefined) {
		// A question asked outside any conversation — a console turn, or a hook with no origin — has no chat to answer in,
		// so it stays the panel's. Without this line the owner actor could settle it from a socket it never arrived on.
		return { ok: false, reason: "this request came from no conversation, so only a device may answer it" };
	}
	if (request.origin.connector !== grant.connector) {
		return { ok: false, reason: `this request came through ${request.origin.connector}, not through this connector` };
	}
	const actor = by.externalActorId;
	if (actor === undefined) {
		return { ok: false, reason: "an answer must name the actor that gave it" };
	}
	if (actor !== grant.owner) {
		return { ok: false, reason: `${actor} is not the owner this connector is configured with` };
	}
	return { ok: true, by: grant.connector };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* The book                                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

/** One page of the transcript when the book reads it. Requests are recent, so a few pages are the whole of what matters. */
const PAGE = 128;
const MAX_PAGES = 20;

/** A committed read of the transcript: the tool's own `commit` (from the hook) or the conversation's (from a route). */
type Reader = (limit: number, cursor: Cursor | undefined) => Promise<{ items: readonly EntryRecord[]; next?: Cursor }>;

/** What one pass over the transcript found: every question and every answer, in entry order. */
interface Folded {
	readonly requests: Map<string, PermissionRequest>;
	readonly answers: Map<string, PermissionAnswer>;
}

type Waiter = (answer: PermissionAnswer) => void;

/**
 * The pending questions and the answers, durable in the transcript and mirrored in memory for the waiters.
 *
 * The transcript is the truth: the hook may rerun after a restart, and the process that asked may be gone. The map is
 * only how a waiting call is woken in this process; a call whose answer was written by the previous process finds it in
 * the log before it waits at all.
 */
export class PermissionBook {
	#conversation: Conversation | undefined;
	readonly #waiters = new Map<string, Set<Waiter>>();

	/** Bound after the root conversation exists: nothing asks a question before the harness can run a turn. */
	attach(conversation: Conversation): void {
		this.#conversation = conversation;
	}

	#attached(): Conversation {
		if (this.#conversation === undefined) {
			throw new Error("the permission book has no conversation yet: the runtime was asked before its root existed");
		}
		return this.#conversation;
	}

	/** Every question still waiting for an answer, oldest first. What `/api/permissions` answers. */
	async pending(): Promise<PermissionRequest[]> {
		const folded = await this.#fold(conversationReader(this.#attached()));
		return (
			[...folded.requests.values()]
				.filter((request) => !folded.answers.has(request.permissionId))
				// The fold reads newest-first (that is where a recent question is), so the queue is turned around here: the
				// route's contract is a queue, and a question that has waited longest is the one a person answers first.
				.sort((left, right) => left.askedAt - right.askedAt)
		);
	}

	/** The pending question with this id, or the answer that settled it. */
	async find(permissionId: string): Promise<{ request?: PermissionRequest; answer?: PermissionAnswer }> {
		const folded = await this.#fold(conversationReader(this.#attached()));
		const request = folded.requests.get(permissionId);
		const answer = folded.answers.get(permissionId);
		return { ...(request === undefined ? {} : { request }), ...(answer === undefined ? {} : { answer }) };
	}

	/**
	 * One answer, committed once. The first authorized answer settles the request; a second one changes nothing and says
	 * so, which is how a double tap and a late answer are the same non-event.
	 */
	async answer(
		permissionId: string,
		answer: "allow" | "deny",
		by: string | undefined,
	): Promise<{ readonly settled: boolean; readonly reason?: string }> {
		const conversation = this.#attached();
		const folded = await this.#fold(conversationReader(conversation));
		const request = folded.requests.get(permissionId);
		if (request === undefined) return { settled: false, reason: "no such request" };
		const existing = folded.answers.get(permissionId);
		if (existing !== undefined) {
			return {
				settled: false,
				reason: existing.answer === "cancelled" ? "the call was cancelled" : "already answered",
			};
		}
		const settled: PermissionAnswer = {
			permissionId,
			answer,
			...(by === undefined ? {} : { by }),
			at: Date.now(),
		};
		await conversation.commit(
			(tx) =>
				tx.appendEntry(conversation.id, {
					kind: PERMISSION_ANSWER_ENTRY_KIND,
					data: {
						permissionId,
						answer,
						...(by === undefined ? {} : { by }),
						at: settled.at,
					},
				}),
			BACKGROUND_CONTEXT,
		);
		this.#wake(permissionId, settled);
		return { settled: true };
	}

	/**
	 * Ask, once, and wait for the answer. Called from the hook, before the call's intent exists.
	 *
	 * The order is the restart story: an answer already in the log is returned without waiting, a request already in the
	 * log is not written twice, and the waiter is registered before the log is read so an answer that lands mid-read wakes
	 * it instead of being missed.
	 */
	async ask(api: HookCommitter, request: PermissionRequest, context: Context): Promise<PermissionAnswer> {
		const read = apiReader(api, context);
		const waiting = this.#register(request.permissionId, context);
		try {
			const folded = await this.#fold(read);
			const answered = folded.answers.get(request.permissionId);
			if (answered !== undefined) {
				// The answer was written before this hook ran, which is exactly what a restart after the answer and before
				// the intent looks like. The waiter registered above is abandoned here, so it is dropped and its abort
				// listener removed: an abandoned promise that rejects when the invocation ends is an unhandled rejection,
				// and an unhandled rejection takes the process down.
				waiting.cancel();
				return answered;
			}
			if (!folded.requests.has(request.permissionId)) {
				await api.commit(
					async (tx) =>
						void (await tx.appendEntry(api.conversationId, {
							kind: PERMISSION_ENTRY_KIND,
							// Plain JSON, field by field: an entry's `data` is JSON, and a request that carried `undefined` would
							// not be the same record after a round trip.
							data: {
								permissionId: request.permissionId,
								tool: {
									name: request.tool.name,
									...(request.tool.connector === undefined ? {} : { connector: request.tool.connector }),
									...(request.tool.tool === undefined ? {} : { tool: request.tool.tool }),
								},
								arguments: request.arguments ?? null,
								reason: request.reason,
								answers: [...request.answers],
								...(request.origin === undefined
									? {}
									: {
											origin: {
												connector: request.origin.connector,
												externalConversationId: request.origin.externalConversationId,
												...(request.origin.externalMessageId === undefined
													? {}
													: { externalMessageId: request.origin.externalMessageId }),
												...(request.origin.externalActorId === undefined
													? {}
													: { externalActorId: request.origin.externalActorId }),
											},
										}),
								askedAt: request.askedAt,
							},
						})),
					context,
				);
			}
			return await waiting.promise;
		} catch (error) {
			waiting.cancel();
			// The wait was cancelled by `/stop`: the request did not run, and saying so closes it for the routes and for a
			// later answer. Written through the conversation rather than the task, because the abandonment that cancelled
			// the wait also ended the invocation the task commits through.
			await this.#cancel(request.permissionId);
			throw error;
		}
	}

	async #fold(read: Reader): Promise<Folded> {
		const requests = new Map<string, PermissionRequest>();
		const answers = new Map<string, PermissionAnswer>();
		let cursor: Cursor | undefined;
		for (let page = 0; page < MAX_PAGES; page += 1) {
			const scanned = await read(PAGE, cursor);
			for (const entry of scanned.items) {
				const request = requestOf(entry);
				if (request !== undefined) requests.set(request.permissionId, request);
				const answer = answerOf(entry);
				// The first answer is the one that counts, and "first" is a time rather than a page: the transcript is read
				// newest-first here and oldest-first on the connector's side, and two folds that disagreed about a double
				// answer would show one outcome and act on another.
				if (answer !== undefined) keepEarliest(answers, answer);
			}
			if (scanned.next === undefined) break;
			cursor = scanned.next;
		}
		return { requests, answers };
	}

	#register(permissionId: string, context: Context): { promise: Promise<PermissionAnswer>; cancel: () => void } {
		const waiters = this.#waiters.get(permissionId) ?? new Set<Waiter>();
		this.#waiters.set(permissionId, waiters);
		const signal = context.abortSignal;
		let settle: (answer: PermissionAnswer) => void = () => {};
		let fail: (error: unknown) => void = () => {};
		const forget = (): void => {
			waiters.delete(waiter);
			signal?.removeEventListener("abort", onAbort);
			if (waiters.size === 0) this.#waiters.delete(permissionId);
		};
		const waiter: Waiter = (answer) => {
			forget();
			settle(answer);
		};
		const onAbort = (): void => {
			forget();
			fail(signal?.reason ?? new Error("the permission wait was cancelled"));
		};
		const promise = new Promise<PermissionAnswer>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		// A waiter can be abandoned: the answer was already in the log, or the turn ended before it was ever awaited. A
		// promise with a rejection handler attached never reports an unhandled rejection, so it marks itself handled here
		// and the caller that does await it still sees the error. Without this, an abandoned waiter rejected at the end of
		// the invocation and took the process down — the exact crash the answered-in-log branch also guards against.
		void promise.catch(() => {});
		waiters.add(waiter);
		// A signal that already fired: the turn was stopped between the call's admission and this wait.
		if (signal?.aborted === true) {
			onAbort();
		} else {
			signal?.addEventListener("abort", onAbort, { once: true });
		}
		return {
			promise,
			cancel: () => {
				forget();
			},
		};
	}

	#wake(permissionId: string, answer: PermissionAnswer): void {
		const waiters = [...(this.#waiters.get(permissionId) ?? [])];
		for (const waiter of waiters) waiter(answer);
	}

	/** Write the cancellation down, so the request stops being pending and a late answer is answered "cancelled". */
	async #cancel(permissionId: string): Promise<void> {
		const conversation = this.#conversation;
		if (conversation === undefined) return;
		try {
			await conversation.commit(
				(tx) =>
					tx.appendEntry(conversation.id, {
						kind: PERMISSION_ANSWER_ENTRY_KIND,
						data: { permissionId, answer: "cancelled", by: "stop", at: Date.now() },
					}),
				BACKGROUND_CONTEXT,
			);
		} catch {
			// The conversation is closing: nothing may be committed, and a request nobody can answer is not worth a second
			// failure on the way out.
		}
	}
}

/**
 * The hook's `api`, as the task runtime it actually is — with the one difference that decides whether this file works.
 *
 * `pi-durable` hands every hook handler the asking task's runtime (`hooks.each(name, (handler) => handler(call, runtime,
 * context))`), and `HookApi` is the declared subset of it: memos, models, committed reads. The gateway needs the same
 * `commit` the task's own `call` phase uses, because the question has to be a transcript entry the connector door can
 * read and a restart can find — a memo is invisible to both.
 *
 * The signature is where the trap is. A tool's `commit` answers with the callback's value; a *task's* `commit` adopts
 * that value as the task's own state — `ToolTask`'s own call phase returns `{ status: "running", checkpoint }` from it.
 * A hook that returned a read's value would therefore overwrite the task record with it, and the scheduler would meet a
 * task whose state has no status. So the type here says the callback answers with nothing, and the cast is checked: a
 * vendor change that takes `commit` away refuses the turn rather than letting a gateway execute without recording
 * anything.
 */
export interface HookCommitter {
	readonly conversationId: ConversationId;
	commit(change: (tx: Tx) => void | Promise<void>, context: Context): Promise<void>;
}

function committer(api: HookApi): HookCommitter {
	const candidate = api as unknown as Partial<HookCommitter>;
	if (typeof candidate.commit !== "function" || candidate.conversationId === undefined) {
		throw new Error(
			"pi-durable's hook api no longer commits: the permission gateway cannot record a request, so no call may run",
		);
	}
	return candidate as HookCommitter;
}

/** The turn, read through a hook's commit: the value goes in a local, because the callback must answer nothing. */
async function hookTurn(api: HookCommitter, context: Context): Promise<TurnOrigin> {
	let origin: TurnOrigin = { kind: "console" };
	await api.commit(async (tx) => {
		const entry = await turnInputIn(tx, api.conversationId);
		if (entry === undefined) return;
		origin = turnOriginOfEntry(entry);
	}, context);
	return origin;
}

/**
 * The transcript as a page reader, from a hook's own `commit`.
 *
 * The value is stashed in a local and the callback answers nothing: a commit's return value is the task's next state, and
 * a read that returned its page would be a task whose state is a page of the log.
 */
function apiReader(api: HookCommitter, context: Context): Reader {
	return async (limit, cursor) => {
		let page: { items: readonly EntryRecord[]; next?: Cursor } = { items: [] };
		await api.commit(async (tx) => {
			page = await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, limit, cursor);
		}, context);
		return page;
	};
}

/** The transcript as a page reader, from a conversation handle: the routes and the connector's answer path. */
/** Hold the earliest answer for an id: the first one to be written is the one that settled the request. */
/**
 * Hold the earliest answer for an id: the first one to be written is the one that settled the request.
 *
 * A tie is broken toward the answer that does less — `cancelled` before `deny` before `allow` — because the two folds
 * read the transcript in opposite directions (newest-first here, oldest-first at the door), and a timestamp equal to the
 * millisecond would otherwise settle one way in the book and the other way where the call runs.
 */
export function keepEarliest(answers: Map<string, PermissionAnswer>, answer: PermissionAnswer): void {
	const held = answers.get(answer.permissionId);
	if (held === undefined || answer.at < held.at) {
		answers.set(answer.permissionId, answer);
		return;
	}
	if (answer.at === held.at && ANSWER_WEIGHT[answer.answer] < ANSWER_WEIGHT[held.answer]) {
		answers.set(answer.permissionId, answer);
	}
}

/** Which answer wins a tie: the one that grants less. */
const ANSWER_WEIGHT: Readonly<Record<PermissionAnswer["answer"], number>> = {
	cancelled: 0,
	deny: 1,
	allow: 2,
};

function conversationReader(conversation: Conversation): Reader {
	return (limit, cursor) => conversation.entries({}, limit, cursor, BACKGROUND_CONTEXT);
}

/** One question, as its entry holds it, or `undefined` for an entry that is not one this build wrote. */
export function requestOf(entry: EntryRecord): PermissionRequest | undefined {
	if (entry.kind !== PERMISSION_ENTRY_KIND) return undefined;
	const data = entry.data as Record<string, unknown> | undefined;
	if (typeof data?.permissionId !== "string") return undefined;
	const tool = data.tool as Record<string, unknown> | undefined;
	if (typeof tool?.name !== "string") return undefined;
	const answers = Array.isArray(data.answers)
		? data.answers.filter((value): value is "allow" | "deny" => value === "allow" || value === "deny")
		: [];
	const origin = originOf(data.origin);
	return {
		permissionId: data.permissionId,
		tool: {
			name: tool.name,
			...(typeof tool.connector === "string" ? { connector: tool.connector } : {}),
			...(typeof tool.tool === "string" ? { tool: tool.tool } : {}),
		},
		arguments: (data.arguments ?? null) as JsonValue,
		reason: typeof data.reason === "string" ? data.reason : "",
		answers: answers.length === 0 ? ["allow", "deny"] : answers,
		...(origin === undefined ? {} : { origin }),
		askedAt: typeof data.askedAt === "number" ? data.askedAt : 0,
	};
}

/** One answer, as its entry holds it. */
export function answerOf(entry: EntryRecord): PermissionAnswer | undefined {
	if (entry.kind !== PERMISSION_ANSWER_ENTRY_KIND) return undefined;
	const data = entry.data as Record<string, unknown> | undefined;
	if (typeof data?.permissionId !== "string") return undefined;
	const answer = data.answer;
	if (answer !== "allow" && answer !== "deny" && answer !== "cancelled") return undefined;
	return {
		permissionId: data.permissionId,
		answer,
		...(typeof data.by === "string" ? { by: data.by } : {}),
		at: typeof data.at === "number" ? data.at : 0,
	};
}

/** The origin a request carries, read with the same rules as a reply's. */
function originOf(value: unknown): Origin | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const origin = value as Record<string, unknown>;
	if (typeof origin.connector !== "string" || typeof origin.externalConversationId !== "string") return undefined;
	return {
		connector: origin.connector,
		externalConversationId: origin.externalConversationId,
		...(typeof origin.externalMessageId === "string" ? { externalMessageId: origin.externalMessageId } : {}),
		...(typeof origin.externalActorId === "string" ? { externalActorId: origin.externalActorId } : {}),
	};
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* The extension                                                                                                     */
/* ---------------------------------------------------------------------------------------------------------------- */

export interface PermissionsOptions {
	/** The boot's configuration. A rule an operator edits is in force at the next boot, like every other entry in it. */
	readonly integrations: () => Record<string, Integration>;
	/** The live catalog, asked afresh for every `mcp_call`: `describe` reconnects and re-lists before it answers. */
	readonly catalog: Pick<McpCatalog, "describe">;
	readonly now?: () => number;
	readonly log?: (line: string) => void;
}

export interface Permissions {
	readonly extension: Extension;
	readonly book: PermissionBook;
	/** Bind the root conversation, after the harness opened it and before any turn can run. */
	attach(conversation: Conversation): void;
}

/** The extension's name: what the startup repair looks for, and what the harness shows. */
export const PERMISSIONS_EXTENSION = "permissions";

export function createPermissions(options: PermissionsOptions): Permissions {
	const book = new PermissionBook();
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => {});

	const gate = hook(ToolTask, {
		beforeTool: async (call, api, context) => {
			// The task runtime the hook is handed, narrowed to the half the gate writes with.
			const runtime = committer(api);
			const origin = await hookTurn(runtime, context);
			const args = (call.arguments ?? {}) as Record<string, unknown>;
			// The catalog is asked before the decision, and it asks the service: `describe` reconnects a server that dropped
			// and re-lists it, so the marker is what the service says now rather than what it said at boot.
			const reading = call.name === MCP_TOOL.call ? await readingOf(options.catalog, args) : undefined;
			const decision = decide({
				toolName: call.name,
				args,
				origin,
				integrations: options.integrations(),
				...(reading === undefined ? {} : { reading }),
			});
			if (decision.kind === "allow") return undefined;
			if (decision.kind === "deny") {
				log(`[permissions] ${call.name} denied: ${decision.reason}`);
				return { block: blocked({ tool: decision.tool, reason: decision.reason }) };
			}
			// A stable id per call attempt: a memo is written once for the task, so a rerun after a restart finds the same
			// question instead of asking a second one about the same call.
			const permissionId = await api.memo(PERMISSION_MEMO, `perm_${randomId()}`, context);
			const request: PermissionRequest = {
				permissionId,
				tool: decision.tool,
				arguments: (call.arguments ?? {}) as JsonValue,
				reason: decision.reason,
				answers: ["allow", "deny"],
				...(origin.kind === "console" || origin.origin === undefined ? {} : { origin: origin.origin }),
				askedAt: now(),
			};
			log(`[permissions] ${call.name} asks: ${decision.reason} (${permissionId})`);
			const answer = await book.ask(runtime, request, context);
			if (answer.answer === "allow") {
				log(`[permissions] ${permissionId} allowed${answer.by === undefined ? "" : ` by ${answer.by}`}`);
				return undefined;
			}
			const reason =
				answer.answer === "cancelled"
					? "the wait was cancelled before anyone answered, so the call did not run"
					: `the operator denied it${answer.by === undefined ? "" : ` (${answer.by})`}`;
			return { block: blocked({ tool: decision.tool, reason, permissionId }) };
		},
	});

	return {
		extension: defineExtension({ name: PERMISSIONS_EXTENSION, hooks: [gate] }),
		book,
		attach: (conversation) => book.attach(conversation),
	};
}

/**
 * What the catalog says about the tool one `mcp_call` would reach, asked now.
 *
 * `describe` is the live read: it reconnects a server that dropped and re-lists it before answering, so this is the same
 * view of the service the call itself will have. `undefined` from it means the service is not answering or no longer
 * offers the tool, and both are a refusal: a call whose effect nobody can see is not one to run.
 */
async function readingOf(catalog: Pick<McpCatalog, "describe">, args: Record<string, unknown>): Promise<MarkerReading> {
	const integration = typeof args.integration === "string" ? args.integration : undefined;
	const tool = typeof args.tool === "string" ? args.tool : undefined;
	if (integration === undefined || tool === undefined) {
		// No reading, and no reading needed: validation refuses this shape before anything runs.
		return { present: false, why: "mcp_call needs an integration and a tool named as the service spells them" };
	}
	const found = await catalog.describe(integration, tool);
	if (found === undefined) {
		// Gone and unreachable are one answer here: both mean the effect cannot be seen, so neither runs. The sentence is the
		// catalog's own, so a caller blocked here and a caller refused by `mcp_call` read the same way out.
		return {
			present: false,
			why: rediscovery(integration, tool, "is not offered any more, or the service is not answering"),
		};
	}
	return { present: true, marker: found.approval };
}

/** The memo that gives one call attempt one permission id, across every rerun of that attempt. */
const PERMISSION_MEMO = "mason.permissions.id";

/**
 * What the model and a script read when a call did not run: one JSON object, so a script can branch on it.
 *
 * `tool` is the mason tool that was blocked and `operation` is what it would have reached (`github/issues.create`), so a
 * script that wrapped several calls can tell which of them the answer was about.
 */
function blocked(input: {
	readonly tool: PermissionTool;
	readonly reason: string;
	readonly permissionId?: string;
}): string {
	const operation =
		input.tool.connector === undefined || input.tool.tool === undefined
			? undefined
			: `${input.tool.connector}/${input.tool.tool}`;
	return JSON.stringify({
		denied: true,
		tool: input.tool.name,
		...(operation === undefined ? {} : { operation }),
		reason: input.reason,
		...(input.permissionId === undefined ? {} : { permissionId: input.permissionId }),
		execute: "not run",
	});
}

/** An id that is unguessable enough to be an identifier and short enough to read in a log. */
function randomId(): string {
	return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
