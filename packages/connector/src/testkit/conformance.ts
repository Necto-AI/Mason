/**
 * The published conformance suite: what any connector can be measured against, and what mason measures its own
 * connectors with.
 *
 * A connector author runs `runConformance(fixture)` in their own repository, against a fake mason the SDK ships, and gets
 * a verdict per case. Nothing here imports mason: a connector is conformant because it does the things below over the
 * published contracts, not because it shares a type with the server.
 *
 * The harness owns `createConnector` on purpose. A fixture describes its medium, its faces and its handlers; the suite
 * wraps every handler so it can see what the connector was actually asked to do. A fixture that built its own connector
 * would be the thing certifying itself.
 */
import type { ControlOp, Session, Target } from "mason-protocol";
import { AttachmentError } from "../attachments.ts";
import {
	type Connector,
	type ConnectorConfig,
	type ConnectorHandlers,
	createConnector,
	type Delivery,
} from "../connector.ts";
import type { ConnectorStore } from "../store.ts";
import { MemoryStore } from "../store-memory.ts";
import { createFakeMason, type FakeMason, type FakeMasonGrants } from "./fake-mason.ts";

export interface ConformanceFaces {
	/** The places this medium can be sent to, as the operator would declare them. */
	readonly targets?: readonly Target[];
	/** The `kind` strings this connector raises. */
	readonly kinds?: readonly string[];
	readonly commands?: readonly ControlOp[];
}

export interface ConformanceFixture {
	readonly name: string;
	readonly version?: string;
	readonly faces: ConformanceFaces;
	/** The medium's behaviour. The suite wraps each hook, so what a case needs to see, it sees. */
	readonly handlers?: Partial<ConnectorHandlers>;
	readonly store?: ConnectorStore;
}

/** Everything the suite saw, recorded around the fixture's own handlers. */
export interface Observed {
	readonly deliveries: Delivery[];
	readonly sessions: Session[];
	readonly closed: string[];
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
	readonly needs?: ReadonlyArray<"targets" | "kinds" | "commands">;
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
		let context: ConformanceContext | undefined;
		try {
			context = await open(fixture);
			await withTimeout(testCase, context, options.timeoutMs ?? 5_000);
			passed.push(testCase.name);
		} catch (error) {
			failed.push({ name: testCase.name, error: error instanceof Error ? error : new Error(String(error)) });
		} finally {
			if (context !== undefined) {
				await context.connector.stop().catch(() => {});
				context.mason.stop();
			}
		}
	}

	return { passed, skipped, failed };
}

function hasFace(fixture: ConformanceFixture, face: "targets" | "kinds" | "commands"): boolean {
	const value = fixture.faces[face];
	return Array.isArray(value) && value.length > 0;
}

async function withTimeout(
	testCase: ConformanceCase,
	context: ConformanceContext,
	timeoutMs: number,
): Promise<void> {
	const timer = new Promise<never>((_, reject) => {
		const handle = setTimeout(
			() => reject(new ConformanceFailure(testCase.name, `no verdict in ${timeoutMs} ms`)),
			timeoutMs,
		);
		handle.unref?.();
	});
	await Promise.race([testCase.run(context), timer]);
}

/** Build the connector the way a real connector is built, with every handler wrapped so the suite can see it. */
export async function open(fixture: ConformanceFixture): Promise<ConformanceContext> {
	const mason = createFakeMason({ connector: fixture.name, granted: grantsOf(fixture) });
	mason.start();

	const observed: Observed = { deliveries: [], sessions: [], closed: [] };
	const handler: Partial<ConnectorHandlers> = { ...(fixture.handlers ?? {}) };

	const handlers: ConnectorHandlers = {
		async onDelivery(delivery) {
			observed.deliveries.push(delivery);
			if (handler.onDelivery === undefined) return { status: "delivered" };
			return handler.onDelivery(delivery);
		},
		onSession(session) {
			observed.sessions.push(session);
			return handler.onSession?.(session);
		},
		onClosed(reason) {
			observed.closed.push(reason);
			return handler.onClosed?.(reason);
		},
	};

	const config: ConnectorConfig = {
		name: fixture.name,
		version: fixture.version ?? "0.0.0-fixture",
		url: "http://mason.test/api/connector",
		credential: "test-credential",
		store: fixture.store ?? new MemoryStore(),
		handlers,
		link: mason.link,
		fetch: mason.fetch,
		readyTimeout: 2_000,
		reconnect: { initialMs: 1, maxMs: 10, factor: 2 },
	};
	const connector = createConnector(config);
	await connector.start();
	// Let mason finish registering the child host: a hold that arrives in the same tick as the connector's hello waits
	// for a connection that is not addressable yet.
	await new Promise((resolve) => setTimeout(resolve, 25));
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

function grantsOf(fixture: ConformanceFixture): FakeMasonGrants {
	return {
		owner: "owner-1",
		targets: fixture.faces.targets ?? [],
		kinds: fixture.faces.kinds ?? [],
		commands: fixture.faces.commands ?? [],
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The cases.
// ---------------------------------------------------------------------------------------------------------------

function fail(name: string, detail: string): never {
	throw new ConformanceFailure(name, detail);
}

function equal(actual: unknown, expected: unknown, what: string): void {
	if (actual !== expected) fail(what, `expected ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`);
}

/** Poll until the predicate holds. Frames are asynchronous; an assertion cannot be. */
export async function waitFor(predicate: () => boolean, what: string, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	fail(what, `never became true within ${timeoutMs} ms`);
}

/** The first target a fixture declared, or a failure: a case that needs one cannot run without it. */
function targetOf(fixture: ConformanceFixture): Target {
	const target = fixture.faces.targets?.[0];
	if (target === undefined) fail("fixture", "a connector with targets needs at least one");
	return target;
}

export function conformanceCases(): readonly ConformanceCase[] {
	return [
		{
			name: "session/the grant is state, and it names the targets and the vocabulary",
			async run({ connector, fixture, observed }) {
				const session = connector.status().session;
				if (session === undefined) fail("session", "no session after start");
				equal(session.protocol, 1, "session protocol major");
				equal(observed.sessions.length, 1, "onSession calls");
				equal(session.targets.length, fixture.faces.targets?.length ?? 0, "targets in the session");
				equal(session.commands.length, fixture.faces.commands?.length ?? 0, "commands in the session");
				if (session.limits.submissionsPerMinute <= 0) fail("session", "a submissions budget of zero");
			},
		},
		{
			name: "submission/one logical operation, and a resend collapses onto it",
			needs: ["targets"],
			async run({ connector, mason }) {
				const first = await connector.submit({
					content: [{ type: "text", text: "one" }],
					origin: { ref: "chat-1" },
					appendId: "fixed-1",
				});
				equal(first.status, "accepted", "submission outcome");
				await connector.submit({ content: [{ type: "text", text: "one" }], origin: { ref: "chat-1" }, appendId: "fixed-1" });
				equal(mason.submissions.length, 1, "submissions mason recorded");
				equal(mason.submissions[0]?.ref, "chat-1", "the address the append carried");
			},
		},
		{
			name: "submission/an append with no address is accepted and answers nobody",
			async run({ connector, mason }) {
				const outcome = await connector.submit({ content: [{ type: "text", text: "from nowhere" }] });
				equal(outcome.status, "accepted", "a submission with no origin");
				equal(mason.submissions[0]?.ref, undefined, "the address a submission without one carries");
			},
		},
		{
			name: "event/a granted kind is an event and never a submission",
			needs: ["kinds"],
			async run({ connector, mason, fixture }) {
				const kind = fixture.faces.kinds?.[0];
				if (kind === undefined) fail("event", "an events face declares no kind");
				const outcome = await connector.event({ kind, payload: { sensor: "hallway" }, appendId: "fire-1" });
				equal(outcome.status, "accepted", "event outcome");
				equal(mason.events.length, 1, "events mason recorded");
				equal(mason.submissions.length, 0, "submissions an event created");
			},
		},
		{
			name: "event/a kind the grant does not name is refused with mason.kind_not_permitted",
			needs: ["kinds"],
			async run({ connector, mason }) {
				const outcome = await connector.event({ kind: "not.granted", payload: {}, appendId: "fire-2" });
				equal(outcome.status, "refused", "outcome for an ungranted kind");
				if (outcome.status === "refused") equal(outcome.code, "mason.kind_not_permitted", "the refusal code");
				equal(mason.events.length, 0, "events mason recorded");
			},
		},
		{
			name: "event/a notice is written down and starts nothing",
			async run({ connector, mason }) {
				const outcome = await connector.notice({ text: "the channel was muted for an hour" });
				equal(outcome.status, "accepted", "notice outcome");
				equal(mason.notices.length, 1, "notices mason recorded");
				equal(mason.submissions.length, 0, "submissions a notice created");
				equal(mason.events.length, 0, "events a notice created");
			},
		},
		{
			name: "delivery/a delivery to a target reaches the handler and is acked",
			needs: ["targets"],
			async run({ mason, observed, fixture }) {
				const ack = await mason.deliver({
					deliveryId: "d-1",
					target: targetOf(fixture).id,
					blocks: [{ type: "text", text: "hello" }],
				});
				equal(ack?.status, "delivered", "delivery ack");
				equal(observed.deliveries.length, 1, "deliveries the handler saw");
				equal(observed.deliveries[0]?.target, targetOf(fixture).id, "the target the handler saw");
			},
		},
		{
			name: "delivery/a delivery with no address goes to the connector's default",
			needs: ["targets"],
			async run({ mason, observed }) {
				const ack = await mason.deliver({ deliveryId: "d-default", blocks: [{ type: "text", text: "hello" }] });
				equal(ack?.status, "delivered", "delivery ack");
				equal(observed.deliveries[0]?.target, undefined, "the target of an unaddressed delivery");
			},
		},
		{
			name: "delivery/a resend under the same id is a duplicate and never a second send",
			needs: ["targets"],
			async run({ mason, observed }) {
				await mason.deliver({ deliveryId: "d-2", blocks: [{ type: "text", text: "once" }] });
				const again = await mason.deliver({ deliveryId: "d-2", blocks: [{ type: "text", text: "once" }] });
				equal(again?.status, "duplicate", "a resent delivery");
				equal(observed.deliveries.length, 1, "the handler ran once");
			},
		},
		{
			name: "delivery/a lost acknowledgement is resent after a reconnect and collapses",
			needs: ["targets"],
			async run({ mason, observed }) {
				mason.loseNextAck();
				const first = await mason.deliver({ deliveryId: "d-3", blocks: [{ type: "text", text: "unknown" }] });
				equal(first, undefined, "the first acknowledgement");
				// The send happened and the answer did not: that is the only state in which a resend says anything.
				await waitFor(() => observed.deliveries.length === 1, "the send reached the medium");
				mason.kill("the acknowledgement was lost");
				await waitFor(() => mason.connected, "the connector reconnected");
				await waitFor(() => mason.deliveries[0]?.ack !== undefined, "the delivery was settled after reconnect");
				equal(mason.deliveries[0]?.ack?.status, "duplicate", "the resent delivery");
				equal(observed.deliveries.length, 1, "the handler ran once");
			},
		},
		{
			name: "delivery/a send that may have happened is uncertain and never retried",
			needs: ["targets"],
			async run(context) {
				const { mason } = context;
				let attempts = 0;
				context.handler.onDelivery = () => {
					attempts += 1;
					throw new Error("the vendor stopped answering");
				};
				mason.loseNextAck();
				const first = await mason.deliver({ deliveryId: "d-4", blocks: [{ type: "text", text: "maybe" }] });
				equal(first, undefined, "the first acknowledgement");
				await waitFor(() => attempts === 1, "the send reached the medium");
				mason.kill("the acknowledgement was lost");
				await waitFor(() => mason.connected, "the connector reconnected");
				await waitFor(() => mason.deliveries[0]?.ack !== undefined, "the delivery was settled after reconnect");
				equal(mason.deliveries[0]?.ack?.status, "uncertain", "the resent delivery");
				equal(attempts, 1, "attempts a person's message was sent with");
			},
		},
		{
			name: "control/a granted control is answered",
			needs: ["commands"],
			async run({ connector, mason, fixture }) {
				const op = fixture.faces.commands?.[0];
				if (op === undefined) fail("control", "no command was granted");
				const result = await connector.control({ op });
				equal(result.handled, true, "the control was taken");
				equal(mason.controls.length, 1, "controls mason recorded");
			},
		},
		{
			name: "control/a control the entry does not grant is refused",
			async run({ connector }) {
				const result = await connector.control({ op: "reboot" as ControlOp });
				equal(result.handled, false, "a control that was never granted");
			},
		},
		{
			name: "budget/a refusal for a spent budget keeps the call journaled and sends it once",
			needs: ["targets"],
			async run({ connector, mason }) {
				mason.exhaust("submissions");
				const outcome = await connector.submit({ content: [{ type: "text", text: "once the minute is over" }], appendId: "budget-1" });
				equal(outcome.status, "pending", "a call refused for budget");
				await waitFor(() => mason.submissions.length === 1, "the retry landed", 3_000);
				equal(mason.submissions[0]?.appendId, "budget-1", "the id the retry carried");
			},
		},
		{
			name: "journal/a call made with no link is sent once the link is back",
			needs: ["targets"],
			async run({ mason, connector }) {
				mason.kill("the link went away");
				const outcome = await connector.submit({ content: [{ type: "text", text: "while you were out" }], appendId: "journaled-1" });
				if (outcome.status === "refused") fail("journal", `the call was refused: ${outcome.code}`);
				await waitFor(() => mason.submissions.length === 1, "the journaled call was replayed", 2_000);
				equal(mason.submissions[0]?.appendId, "journaled-1", "the id the replay carried");
			},
		},
		{
			name: "attachments/an upload comes back as a content id",
			async run({ connector }) {
				const bytes = new Uint8Array([1, 2, 3, 4]);
				const uploaded = await connector.attachments.upload(bytes, { mimeType: "application/octet-stream", name: "a.bin" });
				if (uploaded.contentId.length === 0) fail("attachments", "no content id came back");
				equal(uploaded.size, 4, "uploaded size");
			},
		},
		{
			name: "attachments/a file over the cap is refused before it is sent",
			async run({ connector, mason }) {
				const big = new Uint8Array(2_000_000);
				const before = mason.attachmentPosts();
				const refused = await connector.attachments.upload(big).then(
					() => undefined,
					(error: unknown) => error,
				);
				if (!(refused instanceof AttachmentError)) fail("attachments", "an oversized file was not refused");
				equal(refused.status, 413, "the refusal status");
				equal(mason.attachmentPosts(), before, "uploads that reached mason: the cap is the client's, before a byte");
			},
		},
	];
}
