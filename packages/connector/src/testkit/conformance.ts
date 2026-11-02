/**
 * The published conformance suite: what any connector can be measured against, and what mason measures its own
 * connectors with.
 *
 * A connector author runs `runConformance(fixture)` in their own repository, against a fake mason the SDK ships, and gets
 * a verdict per case. Nothing here imports mason: a connector is conformant because it does the things below over the
 * published protocol, not because it shares a type with the server.
 *
 * The harness owns `createConnector` on purpose. A fixture describes its medium, its faces and its handlers; the suite
 * wraps every handler so it can see what the connector was actually asked to do. A fixture that built its own connector
 * would be the thing certifying itself.
 */
import type {
	Capability,
	DeliveryDeltaParams,
	DeliveryFinalParams,
	DeliveryStartParams,
	ExternalActor,
	ExternalConversation,
	FacesDeclaration,
	InteractionAck,
	InteractionRequestParams,
	StateDeltaParams,
	StateScope,
	StateSnapshotParams,
} from "@mason/protocol";
import { AttachmentError } from "../attachments.ts";
import {
	type Connector,
	type ConnectorConfig,
	type ConnectorHandlers,
	createConnector,
	type Session,
} from "../connector.ts";
import type { ConnectorStore } from "../store.ts";
import { MemoryStore } from "../store-memory.ts";
import { createFakeMason, type FakeMason, type FakeMasonGrants } from "./fake-mason.ts";

export interface UserFace {
	readonly actors?: readonly ExternalActor[];
	readonly conversations?: readonly ExternalConversation[];
	readonly capabilities?: readonly Capability[];
}

export interface ConformanceFaces {
	readonly user?: UserFace;
	/** The `kind` strings this connector fires, and the hook mason would map each to. */
	readonly events?: Readonly<Record<string, string>>;
	readonly tools?: { readonly url: string };
}

export interface ConformanceFixture {
	readonly name: string;
	readonly version?: string;
	readonly faces: ConformanceFaces;
	/** The medium's behaviour. The suite wraps each hook, so what a case needs to see, it sees. */
	readonly handlers?: Partial<ConnectorHandlers>;
	readonly store?: ConnectorStore;
	readonly state?: readonly StateScope[];
	/** How often to ping while idle. The suite leaves it at the protocol's 20 s unless a case needs to see one. */
	readonly heartbeatMs?: number;
}

/** Everything the suite saw, recorded around the fixture's own handlers. */
export interface Observed {
	readonly deliveries: DeliveryFinalParams[];
	readonly starts: DeliveryStartParams[];
	readonly deltas: DeliveryDeltaParams[];
	readonly cancels: string[];
	readonly interactions: InteractionRequestParams[];
	readonly state: Array<StateSnapshotParams | StateDeltaParams>;
	readonly sessions: Session[];
}

export interface ConformanceContext {
	readonly fixture: ConformanceFixture;
	readonly mason: FakeMason;
	readonly connector: Connector;
	readonly observed: Observed;
	/** A case may replace a handler: only this way can "the send failed after it may have left" be staged. */
	handler: Partial<ConnectorHandlers>;
}

export interface ConformanceCase {
	readonly name: string;
	readonly needs?: ReadonlyArray<"user" | "events" | "tools">;
	run(context: ConformanceContext): Promise<void>;
}

export interface ConformanceOptions {
	/** How long a case may take before it is a failure rather than a hang. */
	readonly timeoutMs?: number;
	readonly only?: readonly string[];
}

export interface ConformanceResult {
	readonly passed: readonly string[];
	readonly skipped: readonly string[];
	readonly failed: ReadonlyArray<{ readonly name: string; readonly error: Error }>;
}

export class ConformanceFailure extends Error {
	constructor(caseName: string, detail: string) {
		super(`${caseName}: ${detail}`);
		this.name = "ConformanceFailure";
	}
}

/**
 * Run the suite against one connector. Resolves with the verdict; it does not throw on a failed case, because a caller
 * wants to see every failure at once rather than the first.
 */
export async function runConformance(
	fixture: ConformanceFixture,
	options: ConformanceOptions = {},
): Promise<ConformanceResult> {
	const passed: string[] = [];
	const skipped: string[] = [];
	const failed: Array<{ name: string; error: Error }> = [];

	for (const testCase of conformanceCases()) {
		if (options.only !== undefined && !options.only.some((only) => testCase.name.includes(only))) continue;
		if ((testCase.needs ?? []).some((face) => !hasFace(fixture, face))) {
			skipped.push(testCase.name);
			continue;
		}
		try {
			await withTimeout(testCase, fixture, options.timeoutMs ?? 5_000);
			passed.push(testCase.name);
		} catch (error) {
			failed.push({ name: testCase.name, error: error instanceof Error ? error : new Error(String(error)) });
		}
	}

	return { passed, skipped, failed };
}

function hasFace(fixture: ConformanceFixture, face: "user" | "events" | "tools"): boolean {
	return fixture.faces[face] !== undefined;
}

async function withTimeout(testCase: ConformanceCase, fixture: ConformanceFixture, timeoutMs: number): Promise<void> {
	const context = await open(fixture);
	const timer = new Promise<never>((_, reject) => {
		const handle = setTimeout(
			() => reject(new ConformanceFailure(testCase.name, `no verdict in ${timeoutMs} ms`)),
			timeoutMs,
		);
		handle.unref?.();
	});
	try {
		await Promise.race([testCase.run(context), timer]);
	} finally {
		await context.connector.stop().catch(() => {});
		context.mason.stop();
	}
}

/** Build the connector the way a real connector is built, with every handler wrapped so the suite can see it. */
export async function open(fixture: ConformanceFixture): Promise<ConformanceContext> {
	const grants = grantsOf(fixture);
	const mason = createFakeMason({
		connector: fixture.name,
		granted: grants,
		capabilities: fixture.faces.user?.capabilities ?? ["text"],
	});
	mason.start();

	const observed: Observed = {
		deliveries: [],
		starts: [],
		deltas: [],
		cancels: [],
		interactions: [],
		state: [],
		sessions: [],
	};
	const handler: Partial<ConnectorHandlers> = { ...(fixture.handlers ?? {}) };

	const handlers: ConnectorHandlers = {
		async onDelivery(params) {
			observed.deliveries.push(params);
			if (handler.onDelivery === undefined) return { status: "delivered", external: { id: params.deliveryId } };
			return handler.onDelivery(params);
		},
		onDeliveryStart(params) {
			observed.starts.push(params);
			return handler.onDeliveryStart?.(params);
		},
		onDeliveryDelta(params) {
			observed.deltas.push(params);
			return handler.onDeliveryDelta?.(params);
		},
		onDeliveryCancel(id, reason) {
			observed.cancels.push(id);
			return handler.onDeliveryCancel?.(id, reason);
		},
		onInteraction(params) {
			observed.interactions.push(params);
			if (handler.onInteraction === undefined) return { delivered: true, surface: fixture.name };
			return handler.onInteraction(params);
		},
		onState(frame) {
			observed.state.push(frame);
			return handler.onState?.(frame);
		},
		onSession(session) {
			observed.sessions.push(session);
			return handler.onSession?.(session);
		},
	};

	const config: ConnectorConfig = {
		name: fixture.name,
		version: fixture.version ?? "0.0.0-fixture",
		url: mason.url,
		credential: "test-credential",
		faces: declarationOf(fixture),
		store: fixture.store ?? new MemoryStore(),
		handlers,
		link: mason.link,
		fetch: mason.fetch,
		requestTimeoutMs: 2_000,
		reconnect: { initialMs: 1, maxMs: 10, factor: 2 },
		...(fixture.heartbeatMs === undefined ? {} : { heartbeatMs: fixture.heartbeatMs }),
		...(fixture.state === undefined ? {} : { state: fixture.state }),
	};
	const connector = createConnector(config);
	await connector.start();
	return {
		fixture,
		mason,
		connector,
		observed,
		get handler() {
			return handler;
		},
		set handler(next) {
			Object.assign(handler, next);
		},
	} as ConformanceContext;
}

function declarationOf(fixture: ConformanceFixture): FacesDeclaration {
	const faces: {
		user?: {
			actors?: readonly ExternalActor[];
			conversations?: readonly ExternalConversation[];
			capabilities?: readonly Capability[];
		};
		tools?: { url?: string };
		events?: { kinds?: readonly string[] };
	} = {};
	if (fixture.faces.user !== undefined) {
		faces.user = {
			...(fixture.faces.user.actors === undefined ? {} : { actors: fixture.faces.user.actors }),
			...(fixture.faces.user.conversations === undefined ? {} : { conversations: fixture.faces.user.conversations }),
			...(fixture.faces.user.capabilities === undefined ? {} : { capabilities: fixture.faces.user.capabilities }),
		};
	}
	if (fixture.faces.tools !== undefined) faces.tools = { url: fixture.faces.tools.url };
	if (fixture.faces.events !== undefined) faces.events = { kinds: Object.keys(fixture.faces.events) };
	return faces;
}

function grantsOf(fixture: ConformanceFixture): FakeMasonGrants {
	const grants: {
		user?: FakeMasonGrants["user"];
		tools?: { url: string };
		events?: Readonly<Record<string, string>>;
		state?: readonly string[];
	} = {};
	if (fixture.faces.user !== undefined) {
		grants.user = {
			actors: fixture.faces.user.actors ?? [],
			conversations: fixture.faces.user.conversations ?? [],
			capabilities: fixture.faces.user.capabilities ?? ["text"],
		};
		// A user face may mirror the cheap scopes; `projection` and `tools` are granted separately, and the suite keeps
		// them ungranted so the refusal case has something to refuse.
		grants.state = ["status", "presence"];
	}
	if (fixture.faces.tools !== undefined) grants.tools = { url: fixture.faces.tools.url };
	if (fixture.faces.events !== undefined) grants.events = fixture.faces.events;
	return grants;
}

// ---------------------------------------------------------------------------------------------------------------
// The cases.
// ---------------------------------------------------------------------------------------------------------------

/** The conversation a user-face fixture speaks in, and the person who speaks. Both are the fixture's first of each. */
function originOf(fixture: ConformanceFixture): { externalConversationId: string; connector: string } {
	const conversation = fixture.faces.user?.conversations?.[0]?.externalConversationId;
	if (conversation === undefined)
		throw new ConformanceFailure("fixture", "a user face needs at least one conversation");
	return { externalConversationId: conversation, connector: fixture.name };
}

function actorOf(fixture: ConformanceFixture): ExternalActor | undefined {
	return fixture.faces.user?.actors?.[0];
}

function fail(name: string, detail: string): never {
	throw new ConformanceFailure(name, detail);
}

function equal(actual: unknown, expected: unknown, what: string): void {
	if (actual !== expected) fail(what, `expected ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`);
}

/** Poll until the predicate holds. The in-memory link is synchronous, but handlers are not. */
export async function waitFor(predicate: () => boolean, what: string, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	fail(what, `never became true within ${timeoutMs} ms`);
}

export function conformanceCases(): readonly ConformanceCase[] {
	return [
		{
			name: "handshake/a major both sides speak is negotiated and the session reports it",
			async run({ connector, fixture }) {
				const session = connector.status().session;
				if (session === undefined) fail("handshake", "no session after start");
				equal(session.protocol.major, 1, "handshake protocol major");
				equal(session.connector, fixture.name, "handshake connector name");
				if (session.limits.submissionsPerMinute <= 0 && fixture.faces.user !== undefined) {
					fail("handshake", "a user-face connector needs a submissions budget");
				}
			},
		},
		{
			name: "handshake/a major mason does not speak is refused, not degraded",
			async run({ connector, fixture }) {
				const mason = createFakeMason({
					connector: fixture.name,
					protocol: { major: 2 },
					granted: grantsOf(fixture),
				});
				mason.start();
				const other = createConnector({
					name: fixture.name,
					version: "0.0.0-fixture",
					url: mason.url,
					credential: "test-credential",
					faces: declarationOf(fixture),
					store: new MemoryStore(),
					link: mason.link,
					fetch: mason.fetch,
					requestTimeoutMs: 1_000,
					reconnect: { initialMs: 1, maxMs: 2 },
				});
				let refused: unknown;
				try {
					await other.start();
				} catch (error) {
					refused = error;
				} finally {
					await other.stop().catch(() => {});
					mason.stop();
				}
				if (refused === undefined) fail("handshake", "a major-2 mason accepted the handshake");
				const code = (refused as { data?: { code?: string } }).data?.code;
				equal(code, "mason.protocol_mismatch", "handshake refusal code");
				equal(mason.session, undefined, "handshake wrote no session");
				void connector;
			},
		},
		{
			name: "handshake/a face the operator did not grant is inactive and named",
			async run({ fixture }) {
				const mason = createFakeMason({ connector: fixture.name, granted: {} });
				mason.start();
				const connector = createConnector({
					name: fixture.name,
					version: "0.0.0-fixture",
					url: mason.url,
					credential: "test-credential",
					faces: declarationOf(fixture),
					store: new MemoryStore(),
					link: mason.link,
					fetch: mason.fetch,
					requestTimeoutMs: 1_000,
					reconnect: { initialMs: 1, maxMs: 2 },
				});
				try {
					const session = await connector.start();
					for (const [face, declared] of Object.entries(session.faces)) {
						if (declared !== undefined) fail("handshake", `${face} was granted although nothing is configured`);
					}
					const named = new Set((session.inactive ?? []).map((entry) => entry.face));
					if (fixture.faces.user !== undefined && !named.has("user"))
						fail("handshake", "the user face was dropped silently");
					if (fixture.faces.events !== undefined && !named.has("events"))
						fail("handshake", "the events face was dropped silently");
					if (fixture.faces.tools !== undefined && !named.has("tools"))
						fail("handshake", "the tools face was dropped silently");
				} finally {
					await connector.stop().catch(() => {});
					mason.stop();
				}
			},
		},
		{
			name: "submission/one logical operation, and a resend collapses onto it",
			needs: ["user"],
			async run({ connector, mason, fixture }) {
				const first = await connector.submit({
					origin: originOf(fixture),
					...(actorOf(fixture) === undefined ? {} : { actor: actorOf(fixture) }),
					content: [{ type: "text", text: "one" }],
					submissionId: "fixed-1",
				});
				equal(first.status, "accepted", "submission outcome");
				const again = await connector.submit({
					origin: originOf(fixture),
					...(actorOf(fixture) === undefined ? {} : { actor: actorOf(fixture) }),
					content: [{ type: "text", text: "one" }],
					submissionId: "fixed-1",
				});
				if (again.status !== "duplicate" && again.status !== "accepted")
					fail("submission", `a resend was ${again.status}`);
				equal(mason.submissions.length, 1, "submissions mason recorded");
			},
		},
		{
			name: "submission/an actor mason does not map is refused",
			needs: ["user"],
			async run({ connector, mason, fixture }) {
				const outcome = await connector.submit({
					origin: originOf(fixture),
					actor: { externalActorId: "nobody-999", displayName: "Nobody" },
					content: [{ type: "text", text: "hello" }],
					submissionId: "unknown-actor",
				});
				equal(outcome.status, "refused", "outcome for an unmapped actor");
				if (outcome.status === "refused") equal(outcome.error.code, "mason.actor_unknown", "refusal code");
				equal(mason.submissions.length, 0, "submissions mason recorded");
			},
		},
		{
			name: "submission/a conversation the entry does not permit is refused",
			needs: ["user"],
			async run({ connector, mason, fixture }) {
				const outcome = await connector.submit({
					origin: { connector: fixture.name, externalConversationId: "elsewhere" },
					...(actorOf(fixture) === undefined ? {} : { actor: actorOf(fixture) }),
					content: [{ type: "text", text: "hello" }],
					submissionId: "bad-room",
				});
				equal(outcome.status, "refused", "outcome for an unpermitted room");
				if (outcome.status === "refused")
					equal(outcome.error.code, "mason.conversation_not_permitted", "refusal code");
				equal(mason.submissions.length, 0, "submissions mason recorded");
			},
		},
		{
			name: "fire/a service event is a fire and never a submission",
			needs: ["events"],
			async run({ connector, mason, fixture }) {
				const kind = Object.keys(fixture.faces.events ?? {})[0];
				if (kind === undefined) fail("fire", "an events face declares no kind");
				const outcome = await connector.fire({ kind, payload: { sensor: "hallway" }, fireId: "fire-1" });
				equal(outcome.status, "accepted", "fire outcome");
				equal(mason.fires.length, 1, "fires mason recorded");
				equal(mason.submissions.length, 0, "submissions a fire created");
			},
		},
		{
			name: "fire/a kind no hook maps is refused",
			needs: ["events"],
			async run({ connector, mason }) {
				const outcome = await connector.fire({ kind: "not.mapped", payload: {}, fireId: "fire-2" });
				equal(outcome.status, "refused", "outcome for an unmapped kind");
				if (outcome.status === "refused") equal(outcome.error.code, "mason.kind_not_permitted", "refusal code");
				equal(mason.fires.length, 0, "fires mason recorded");
			},
		},
		{
			name: "fire/a fire keeps its identity across a resend",
			needs: ["events"],
			async run({ connector, mason, fixture }) {
				const kind = Object.keys(fixture.faces.events ?? {})[0];
				if (kind === undefined) fail("fire", "an events face declares no kind");
				await connector.fire({ kind, payload: {}, fireId: "fire-3" });
				const again = await connector.fire({ kind, payload: {}, fireId: "fire-3" });
				if (again.status !== "duplicate" && again.status !== "accepted")
					fail("fire", `a resend was ${again.status}`);
				equal(mason.fires.length, 1, "fires mason recorded");
			},
		},
		{
			name: "control/stop is answered even after the fire budget is spent",
			async run({ connector, mason, fixture }) {
				if (fixture.faces.events !== undefined) {
					mason.exhaust("fires");
					const kind = Object.keys(fixture.faces.events ?? {})[0];
					if (kind !== undefined) {
						// A retryable refusal is not a verdict: the SDK keeps the call journaled and the connector's own loop
						// resends it on the next flush. What matters here is that it did not become two operations, and that
						// stop still got through while the fire budget was spent.
						const flooded = await connector.fire({ kind, payload: {}, fireId: "flood-1" });
						equal(flooded.status, "pending", "a fire over its budget");
						equal(mason.fires.length, 0, "fires a rate-limited call created");
					}
				}
				const stop = await connector.control({ op: "stop" });
				equal(stop.handled, true, "stop while a budget is spent");
			},
		},
		{
			name: "delivery/a slow send is not sent twice while it is still in flight",
			needs: ["user"],
			async run(context) {
				const { mason, observed } = context;
				let sends = 0;
				context.handler.onDelivery = async (params) => {
					sends += 1;
					// One turn of the loop: a real connector talks to a vendor here, which is the window in which a naive
					// replay would send the same message a second time.
					await new Promise((resolve) => setTimeout(resolve, 5));
					return { status: "delivered", external: { id: params.deliveryId } };
				};
				const [first, second] = await Promise.all([
					mason.deliver({
						deliveryId: "d-slow",
						origin: originOf(context.fixture),
						blocks: [{ type: "text", text: "hi" }],
					}),
					mason.deliver({
						deliveryId: "d-slow",
						origin: originOf(context.fixture),
						blocks: [{ type: "text", text: "hi" }],
					}),
				]);
				for (const ack of [first, second]) {
					if (ack === undefined) fail("delivery", "a delivery went unanswered");
					if (ack.status !== "delivered" && ack.status !== "duplicate")
						fail("delivery", `an ack was ${ack.status}`);
				}
				equal(sends, 1, "sends for one delivery id");
				equal(observed.deliveries.length, 1, "handler runs for one delivery id");
			},
		},
		{
			name: "heartbeat/an idle socket is pinged and mason answers",
			async run({ fixture }) {
				const mason = createFakeMason({ connector: fixture.name, granted: grantsOf(fixture) });
				mason.start();
				const connector = createConnector({
					name: fixture.name,
					version: "0.0.0-fixture",
					url: mason.url,
					credential: "test-credential",
					faces: declarationOf(fixture),
					store: new MemoryStore(),
					link: mason.link,
					fetch: mason.fetch,
					requestTimeoutMs: 1_000,
					heartbeatMs: 20,
					reconnect: { initialMs: 1, maxMs: 5 },
				});
				try {
					await connector.start();
					await waitFor(() => mason.pings() >= 1, "a keepalive was answered", 2_000);
					equal(connector.status().connected, true, "the socket after a keepalive");
				} finally {
					await connector.stop().catch(() => {});
					mason.stop();
				}
			},
		},
		{
			name: "budget/a refusal for budget is retried after the wait mason asked for",
			needs: ["user"],
			async run({ connector, mason, fixture }) {
				mason.exhaust("submissions");
				const outcome = await connector.submit({
					origin: originOf(fixture),
					...(actorOf(fixture) === undefined ? {} : { actor: actorOf(fixture) }),
					content: [{ type: "text", text: "once the minute is over" }],
					submissionId: "budget-1",
				});
				equal(outcome.status, "pending", "a call refused for budget");
				await waitFor(() => mason.submissions.length === 1, "the retry landed", 3_000);
				equal(mason.submissions[0]?.submissionId, "budget-1", "the id the retry carried");
			},
		},
		{
			name: "delivery/a reply reaches the origin and is acknowledged once",
			needs: ["user"],
			async run({ mason, observed, fixture }) {
				const ack = await mason.deliver({
					deliveryId: "d-1",
					origin: originOf(fixture),
					blocks: [{ type: "text", text: "hello" }],
				});
				equal(ack?.status, "delivered", "delivery ack");
				equal(observed.deliveries.length, 1, "deliveries the handler saw");
				equal(observed.deliveries[0]?.blocks.length, 1, "blocks the handler saw");
			},
		},
		{
			name: "delivery/a resend under the same id is a duplicate and never a second send",
			needs: ["user"],
			async run({ mason, observed, fixture }) {
				await mason.deliver({
					deliveryId: "d-2",
					origin: originOf(fixture),
					blocks: [{ type: "text", text: "once" }],
				});
				const again = await mason.deliver({
					deliveryId: "d-2",
					origin: originOf(fixture),
					blocks: [{ type: "text", text: "once" }],
				});
				equal(again?.status, "duplicate", "a resent delivery");
				equal(observed.deliveries.length, 1, "the handler ran once");
			},
		},
		{
			name: "delivery/a lost acknowledgement is resent and collapses onto the first send",
			needs: ["user"],
			async run({ mason, observed, fixture }) {
				mason.loseNextAck();
				const first = await mason.deliver({
					deliveryId: "d-3",
					origin: originOf(fixture),
					blocks: [{ type: "text", text: "unknown" }],
				});
				equal(first, undefined, "the first acknowledgement");
				mason.kill("the acknowledgement was lost");
				await waitFor(() => mason.connected, "the connector reconnected");
				await waitFor(() => mason.deliveries[0]?.ack !== undefined, "the delivery was settled after reconnect");
				equal(mason.deliveries[0]?.ack?.status, "duplicate", "the resent delivery");
				equal(observed.deliveries.length, 1, "the handler ran once");
			},
		},
		{
			name: "delivery/a send that may have happened is reported uncertain and never retried",
			needs: ["user"],
			async run(context) {
				const { mason } = context;
				let attemptsToVendor = 0;
				context.handler.onDelivery = () => {
					attemptsToVendor += 1;
					throw new Error("the vendor stopped answering");
				};
				// The acknowledgement is lost, which is the only way an uncertain outcome can be asked about twice.
				mason.loseNextAck();
				const first = await mason.deliver({
					deliveryId: "d-4",
					origin: originOf(context.fixture),
					blocks: [{ type: "text", text: "maybe" }],
				});
				equal(first, undefined, "the first acknowledgement");
				mason.kill("the acknowledgement was lost");
				await waitFor(() => mason.connected, "the connector reconnected");
				await waitFor(() => mason.deliveries[0]?.ack !== undefined, "the delivery was settled after reconnect");
				equal(mason.deliveries[0]?.ack?.status, "uncertain", "the resent delivery");
				equal(attemptsToVendor, 1, "attempts a person's message was sent with");
			},
		},
		{
			name: "delivery/start and delta and final share one delivery id",
			needs: ["user"],
			async run({ mason, observed, fixture }) {
				const origin = originOf(fixture);
				mason.startDelivery({ deliveryId: "d-5", origin, blocks: [{ type: "text", text: "par" }] });
				mason.deltaDelivery({ deliveryId: "d-5", blocks: [{ type: "text", text: "tial" }] });
				const ack = await mason.deliver({ deliveryId: "d-5", origin, blocks: [{ type: "text", text: "partial" }] });
				equal(ack?.status, "delivered", "delivery ack");
				equal(observed.starts.length, 1, "starts the handler saw");
				equal(observed.deltas.length, 1, "deltas the handler saw");
				equal(observed.starts[0]?.deliveryId, observed.deltas[0]?.deliveryId, "the ids the handler saw");
				equal(observed.deliveries[0]?.deliveryId, "d-5", "the final delivery id");
			},
		},
		{
			name: "interaction/a permission request is put to a person and answered once",
			needs: ["user"],
			async run({ mason, connector, fixture }) {
				const ack = await mason.requestInteraction({
					permissionId: "p-1",
					tool: { name: "send_message", connector: fixture.name },
					arguments: { chat_id: "-100" },
					reason: "sending outside the conversation that asked",
					answers: ["allow", "deny"],
					origin: originOf(fixture),
				});
				equal(ack?.delivered, true, "the request reached a surface");
				const first = await connector.answer({
					permissionId: "p-1",
					answer: "allow",
					...(actorOf(fixture) === undefined ? {} : { by: actorOf(fixture) }),
				});
				equal(first.settled, true, "the first answer settled it");
				const second = await connector.answer({ permissionId: "p-1", answer: "deny" });
				equal(second.settled, false, "a second answer");
				equal(mason.answers.length, 1, "answers mason recorded");
			},
		},
		{
			name: "interaction/a request that was already settled is not put to a person twice",
			needs: ["user"],
			async run({ mason, connector, fixture }) {
				const params: InteractionRequestParams = {
					permissionId: "p-2",
					tool: { name: "send_file", connector: fixture.name },
					arguments: {},
					reason: "a file leaves the conversation",
					answers: ["allow", "deny"],
					origin: originOf(fixture),
				};
				await mason.requestInteraction(params);
				await connector.answer({ permissionId: "p-2", answer: "deny" });
				const again: InteractionAck | undefined = await mason.requestInteraction(params);
				equal(again?.delivered, false, "a request after it was settled");
			},
		},
		{
			name: "state/a snapshot then a delta keeps one monotonic number",
			needs: ["user"],
			async run({ mason, observed, fixture, connector }) {
				await connector.subscribe(["status"]);
				mason.snapshot({ scopes: ["status"], status: { runStatus: "idle" } });
				mason.delta({ scope: "status", op: "set", path: "runStatus", value: "generating" });
				await waitFor(() => observed.state.length >= 2, "both state frames arrived");
				const [first, second] = observed.state;
				if (first === undefined || second === undefined) fail("state", "frames missing");
				if (second.seq <= first.seq) fail("state", `${second.seq} did not follow ${first.seq}`);
				void fixture;
			},
		},
		{
			name: "state/a scope the entry did not grant is refused",
			needs: ["user"],
			async run({ connector }) {
				const slept = await connector.subscribe(["projection"]).then(
					() => undefined,
					(error: unknown) => error,
				);
				if (slept === undefined) fail("state", "a scope outside the grant was accepted");
				void slept;
			},
		},
		{
			name: "attachments/bytes round-trip through a content id",
			needs: ["user"],
			async run({ connector }) {
				const bytes = new Uint8Array([1, 2, 3, 4]);
				const uploaded = await connector.attachments.upload(bytes, {
					mimeType: "application/octet-stream",
					name: "a.bin",
				});
				if (uploaded.contentId.length === 0) fail("attachments", "no content id came back");
				const back = await connector.attachments.download(uploaded.contentId);
				equal(back.size, 4, "downloaded size");
				equal([...back.bytes].join(","), [1, 2, 3, 4].join(","), "downloaded bytes");
			},
		},
		{
			name: "attachments/a file over the cap is refused before it is sent",
			needs: ["user"],
			async run({ connector, mason }) {
				const big = new Uint8Array(2_000_000);
				const before = mason.attachmentPosts();
				const refused = await connector.attachments.upload(big).then(
					() => undefined,
					(error: unknown) => error,
				);
				if (!(refused instanceof AttachmentError)) fail("attachments", "an oversized file was not refused");
				equal(refused.status, 413, "the refusal status");
				equal(
					mason.attachmentPosts(),
					before,
					"uploads that reached mason: the cap is the client's, before a byte",
				);
			},
		},
		{
			name: "journal/a call made with no socket is sent once the socket is back",
			needs: ["user"],
			async run({ mason, connector, fixture }) {
				mason.kill("the socket went away");
				const outcome = await connector.submit({
					origin: originOf(fixture),
					...(actorOf(fixture) === undefined ? {} : { actor: actorOf(fixture) }),
					content: [{ type: "text", text: "while you were out" }],
					submissionId: "journaled-1",
				});
				if (outcome.status === "refused") fail("journal", `the call was refused: ${outcome.error.code}`);
				await waitFor(() => mason.submissions.length === 1, "the journaled call was replayed", 2_000);
				equal(mason.submissions[0]?.submissionId, "journaled-1", "the id the replay carried");
			},
		},
	];
}

/**
 * Nothing to export here yet: a tools-face case needs live MCP discovery, which is masonry the server half owns. The
 * tools-only fixture passes the handshake, grant and control cases, and says so in the suite's skipped list rather than
 * passing a case that would prove nothing.
 */
