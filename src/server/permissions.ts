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
 * - `mcp_call` is decided by the tool's own `dev.mason/approval` marker, read from the live catalog, inside the
 *   operator's ceiling: a `deny` rule refuses, an `ask` rule asks, `required` asks, and `not_required` is allowed only
 *   when the operator trusted that connector's markers or an `allow` rule names the tool. A tool the catalog no longer
 *   has is let through so its own rediscovery result is the one the caller reads.
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
 * A request is routed to a surface only when the person who started the turn is the approver the operator configured on
 * that connector (`connector.user.approver`). Otherwise it stays visibly pending and the owner answers it through
 * `POST /api/permissions/<id>` — the admin panel's route (#103), which is why an offline approver leaves a request
 * pending rather than silently denying it.
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
import type { Origin } from "@mason/protocol";
import type { Integration } from "./integrations.ts";
import type { McpCatalog } from "./mcp.ts";
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
	/** The roster name with authority to answer, when the operator configured one. Absent: only the owner may. */
	readonly approver?: string;
	/** The roster name whose words started the turn, when a person's words did. Authority to approve is a name. */
	readonly askedBy?: string;
	/** Where the turn came from, which is where the question goes when that person is the approver. */
	readonly origin?: Origin;
	readonly askedAt: number;
}

/** One answer, as `app.permission-answer` holds it. */
export interface PermissionAnswer {
	readonly permissionId: string;
	readonly answer: PermissionOutcome;
	/** Who answered: a roster name, or `stop` when the runtime cancelled the wait. */
	readonly by?: string;
	readonly at: number;
}

/** What the gate came to for one call. */
export type PermissionDecision =
	| { readonly kind: "allow" }
	| { readonly kind: "deny"; readonly reason: string; readonly tool: PermissionTool }
	| { readonly kind: "ask"; readonly reason: string; readonly tool: PermissionTool };

/** What the gate is asked, apart from the call itself: the policy in force and the catalog as it stands now. */
export interface PermissionInputs {
	readonly toolName: string;
	readonly args: Record<string, unknown>;
	readonly origin: TurnOrigin;
	readonly integrations: Record<string, Integration>;
	readonly catalog: Pick<McpCatalog, "approvalOf">;
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
	const listed = inputs.catalog.approvalOf(integration, tool);
	if (listed === undefined) {
		// The catalog no longer has it: the call's own result says so, with the rediscovery step, and asking a person about a
		// tool that is gone would be a question with no right answer.
		return { kind: "allow" };
	}
	const rule = inputs.integrations[integration]?.connector;
	const policy = rule?.policy;
	const subject = { name: "mcp_call", connector: integration, tool };
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
	// model is told to make.
	if (inputs.origin.kind === "connector") {
		const carried = inputs.origin.origin;
		if (carried.connector === target.connector && carried.externalConversationId === target.conversation) {
			return { kind: "allow" };
		}
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
 * The roster name with authority to answer a request from this turn, or `undefined` when the operator configured none.
 *
 * It is a claim the config backs and the roster has to hold: a connector that maps its actors to names says which of
 * those names may approve, and an actor that maps to somebody else gets no authority from having spoken.
 */
export function approverFor(origin: TurnOrigin, integrations: Record<string, Integration>): string | undefined {
	return grantOf(origin, integrations)?.approver;
}

/** The surface a pending request may be sent to: only where the person who asked is the approver. */
export function surfaceFor(
	request: PermissionRequest,
	integrations: Record<string, Integration>,
): { readonly connector: string; readonly conversation: string } | undefined {
	const carried = request.origin;
	if (carried === undefined || request.approver === undefined) return undefined;
	const grant = integrations[carried.connector]?.connector?.user;
	// The configuration may have changed since the question was written: the surface is what the file says now.
	if (grant?.approver !== request.approver) return undefined;
	// Only the approver's own words are answered where they were said. Anyone else's question stays pending in the owner's
	// list, because showing it in a room the approver does not own would put another person's work in front of strangers.
	if (request.askedBy !== grant.approver) return undefined;
	return { connector: carried.connector, conversation: carried.externalConversationId };
}

/** Whether an actor a connector names may answer this request. The owner's own route never asks this. */
export function mayAnswer(
	request: PermissionRequest,
	grant: { readonly approver?: string; readonly actors: Readonly<Record<string, string>> },
	by: { readonly externalActorId?: string },
): { readonly ok: true; readonly by: string } | { readonly ok: false; readonly reason: string } {
	if (grant.approver === undefined) {
		return { ok: false, reason: "this connector has no approver configured, so nobody on it may answer" };
	}
	if (request.approver !== undefined && request.approver !== grant.approver) {
		return { ok: false, reason: `this request is for ${request.approver}, not for ${grant.approver}` };
	}
	const actor = by.externalActorId;
	if (actor === undefined) {
		return { ok: false, reason: "an answer must name the actor that gave it" };
	}
	const who = grant.actors[actor];
	if (who !== grant.approver) {
		return { ok: false, reason: `${who ?? actor} is not the approver this connector is configured with` };
	}
	return { ok: true, by: who };
}

function grantOf(origin: TurnOrigin, integrations: Record<string, Integration>) {
	if (origin.kind !== "connector") return undefined;
	return integrations[origin.origin.connector]?.connector?.user;
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
		return [...folded.requests.values()].filter((request) => !folded.answers.has(request.permissionId));
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
			if (answered !== undefined) return answered;
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
								...(request.approver === undefined ? {} : { approver: request.approver }),
								...(request.askedBy === undefined ? {} : { askedBy: request.askedBy }),
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
				// The first answer is the one that counts; a second entry would be a bug, and reading it as another answer
				// would make the bug visible as a changed outcome.
				if (answer !== undefined && !answers.has(answer.permissionId)) {
					answers.set(answer.permissionId, answer);
				}
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

/** The turn, read through a hook's commit: the values go in locals, because the callback must answer nothing. */
async function hookTurn(api: HookCommitter, context: Context): Promise<{ origin: TurnOrigin; askedBy?: string }> {
	let origin: TurnOrigin = { kind: "console" };
	let askedBy: string | undefined;
	await api.commit(async (tx) => {
		const entry = await turnInputIn(tx, api.conversationId);
		if (entry === undefined) return;
		origin = turnOriginOfEntry(entry);
		const person = (entry.data as { person?: unknown } | undefined)?.person;
		if (typeof person === "string") askedBy = person;
	}, context);
	return { origin, ...(askedBy === undefined ? {} : { askedBy }) };
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
	const approver = typeof data.approver === "string" ? data.approver : undefined;
	const askedBy = typeof data.askedBy === "string" ? data.askedBy : undefined;
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
		...(approver === undefined ? {} : { approver }),
		...(askedBy === undefined ? {} : { askedBy }),
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
	/** The boot's configuration, read per call: a rule an operator edits is in force at the next turn, not the next boot. */
	readonly integrations: () => Record<string, Integration>;
	readonly catalog: Pick<McpCatalog, "approvalOf">;
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
			const { origin, askedBy } = await hookTurn(runtime, context);
			const decision = decide({
				toolName: call.name,
				args: (call.arguments ?? {}) as Record<string, unknown>,
				origin,
				integrations: options.integrations(),
				catalog: options.catalog,
			});
			if (decision.kind === "allow") return undefined;
			if (decision.kind === "deny") {
				log(`[permissions] ${call.name} denied: ${decision.reason}`);
				return { block: blocked({ tool: decision.tool, reason: decision.reason }) };
			}
			// A stable id per call attempt: a memo is written once for the task, so a rerun after a restart finds the same
			// question instead of asking a second one about the same call.
			const permissionId = await api.memo(PERMISSION_MEMO, `perm_${randomId()}`, context);
			const approver = approverFor(origin, options.integrations());
			const request: PermissionRequest = {
				permissionId,
				tool: decision.tool,
				arguments: (call.arguments ?? {}) as JsonValue,
				reason: decision.reason,
				answers: ["allow", "deny"],
				...(approver === undefined ? {} : { approver }),
				...(askedBy === undefined ? {} : { askedBy }),
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
