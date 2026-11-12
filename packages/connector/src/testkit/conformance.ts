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
import type { ControlOp, Session } from "mason-protocol";
import { AttachmentError } from "../attachments.ts";
import {
	type Connector,
	type ConnectorConfig,
	type ConnectorHandlers,
	createConnector,
	type Delivery,
	type InboundOutcome,
} from "../connector.ts";
import type { ConnectorStore } from "../store.ts";
import { MemoryStore } from "../store-memory.ts";
import { createFakeMason, type FakeMason, type FakeMasonGrants } from "./fake-mason.ts";

export interface ConformanceFaces {
	/**
	 * The actor this medium speaks as. `""` is the entry whose grant names no `user` at all: it may raise events, write
	 * notices and answer controls, and it may not carry a person's words.
	 */
	readonly owner?: string;
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
	/** The faces the fixture must declare for this case to mean anything. A case about a face's absence does not use it. */
	readonly needs?: ReadonlyArray<"kinds" | "commands" | "owner">;
	/**
	 * A grant this case is measured against instead of the one the fixture's faces describe. A case whose subject is a
	 * refusal cannot be staged with a fixture that declares the face, and the refusal is the door's to make.
	 */
	readonly grant?: Partial<FakeMasonGrants>;
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
			context = await open(fixture, testCase.grant);
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

function hasFace(fixture: ConformanceFixture, face: "kinds" | "commands" | "owner"): boolean {
	if (face === "owner") return (fixture.faces.owner ?? "owner-1") !== "";
	const value = fixture.faces[face];
	return Array.isArray(value) && value.length > 0;
}

async function withTimeout(testCase: ConformanceCase, context: ConformanceContext, timeoutMs: number): Promise<void> {
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
export async function open(
	fixture: ConformanceFixture,
	grant: Partial<FakeMasonGrants> = {},
): Promise<ConformanceContext> {
	const mason = createFakeMason({ connector: fixture.name, granted: { ...grantsOf(fixture), ...grant } });
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
		// `owner: ""` is the fixture that declares no user face, which is `null` to the fake: absent is not the same
		// statement as "nobody", and a fixture that says nobody is testing the door's first refusal.
		owner: fixture.faces.owner === "" ? null : (fixture.faces.owner ?? "owner-1"),
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

export function conformanceCases(): readonly ConformanceCase[] {
	return [
		{
			name: "session/the grant is state, and it names the vocabulary and the budgets",
			async run({ connector, fixture, observed }) {
				const session = connector.status().session;
				if (session === undefined) fail("session", "no session after start");
				equal(session.protocol, 1, "session protocol major");
				equal(observed.sessions.length, 1, "onSession calls");
				equal(session.commands.length, fixture.faces.commands?.length ?? 0, "commands in the session");
				if (session.limits.submissionsPerMinute <= 0) fail("session", "a submissions budget of zero");
			},
		},
		{
			name: "submission/one logical operation, and a resend collapses onto it",
			needs: ["owner"],
			async run({ connector, mason }) {
				const first = await connector.submit({
					content: [{ type: "text", text: "one" }],
					origin: { ref: "chat-1" },
					appendId: "fixed-1",
				});
				equal(first.status, "accepted", "submission outcome");
				await connector.submit({
					content: [{ type: "text", text: "one" }],
					origin: { ref: "chat-1" },
					appendId: "fixed-1",
				});
				equal(mason.submissions.length, 1, "submissions mason recorded");
				equal(mason.submissions[0]?.ref, "chat-1", "the address the append carried");
			},
		},
		{
			name: "submission/an actor that is not the granted owner is refused",
			needs: ["owner"],
			async run({ connector, mason }) {
				// The forge: the credential is the connector's, but the words claim to be somebody the grant never named.
				const outcome = await connector.submit({
					content: [{ type: "text", text: "it is me, your owner" }],
					origin: { ref: "chat-1", actor: { id: "somebody-else" } },
				});
				equal(outcome.status, "refused", "a forged actor");
				equal(outcome.status === "refused" ? outcome.code : undefined, "mason.actor_unknown", "the refusal code");
				equal(mason.submissions.length, 0, "a refused submission places nothing");
			},
		},
		{
			name: "grant/an entry that grants no user refuses words",
			grant: { owner: null },
			async run({ connector, mason }) {
				// The face itself is the first ceiling: an entry the operator gave events and no `user` may be spoken through
				// by nobody, and the refusal is the door's rather than the connector's guess at what it holds.
				const outcome = await connector.submit({
					content: [{ type: "text", text: "somebody typed this" }],
					origin: { ref: "chat-1" },
					appendId: "no-face-1",
				});
				equal(outcome.status, "refused", "a submission to an entry that grants no user");
				equal(
					outcome.status === "refused" ? outcome.code : undefined,
					"mason.face_not_granted",
					"the refusal code",
				);
				equal(mason.submissions.length, 0, "a refused submission places nothing");
				// The face it does hold is untouched: a notice is still a row the connector may write.
				const written = await connector.notice({ text: "the alarm was silenced", appendId: "no-face-2" });
				equal(written.status, "accepted", "a notice from an entry with no user");
				equal(mason.notices.length, 1, "notices mason recorded");
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
			name: "delivery/a delivery carries the address the turn came from",
			async run({ mason, observed }) {
				const ack = await mason.deliver({
					deliveryId: "d-1",
					ref: "chat-1",
					blocks: [{ type: "text", text: "hello" }],
				});
				equal(ack?.status, "delivered", "delivery ack");
				equal(observed.deliveries.length, 1, "deliveries the handler saw");
				equal(observed.deliveries[0]?.ref, "chat-1", "the address the handler saw: where the words came from");
			},
		},
		{
			name: "delivery/a delivery with no address goes to the connector's default",
			async run({ mason, observed }) {
				const ack = await mason.deliver({ deliveryId: "d-default", blocks: [{ type: "text", text: "hello" }] });
				equal(ack?.status, "delivered", "delivery ack");
				equal(
					observed.deliveries.at(-1)?.ref,
					undefined,
					"the address an unaddressed delivery reaches the handler with",
				);
			},
		},
		{
			name: "delivery/a resend under the same id is a duplicate and never a second send",
			async run({ mason, observed }) {
				await mason.deliver({ deliveryId: "d-2", blocks: [{ type: "text", text: "once" }] });
				const again = await mason.deliver({ deliveryId: "d-2", blocks: [{ type: "text", text: "once" }] });
				equal(again?.status, "duplicate", "a resent delivery");
				equal(observed.deliveries.length, 1, "the handler ran once");
			},
		},
		{
			name: "delivery/a lost acknowledgement is resent after a reconnect and collapses",
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
			needs: ["owner"],
			async run({ connector, mason }) {
				mason.exhaust("submissions");
				const outcome = await connector.submit({
					content: [{ type: "text", text: "once the minute is over" }],
					appendId: "budget-1",
				});
				equal(outcome.status, "pending", "a call refused for budget");
				await waitFor(() => mason.submissions.length === 1, "the retry landed", 3_000);
				equal(mason.submissions[0]?.appendId, "budget-1", "the id the retry carried");
			},
		},
		{
			name: "budget/a notice spends the submission budget",
			async run({ connector, mason }) {
				const limit = connector.status().session?.limits.submissionsPerMinute ?? 0;
				if (limit < 2) fail("budget", "a submissions budget with no room to spend it");
				// A notice is words in the transcript, so the door charges it to the same minute as a submission. Mixing the
				// two is what proves the one budget covers both: the last call finds the minute spent either way.
				let last: InboundOutcome | undefined;
				for (let index = 0; index <= limit; index += 1) {
					last =
						index % 2 === 0
							? await connector.submit({
									content: [{ type: "text", text: `m${index}` }],
									appendId: `budget-mixed-${index}`,
								})
							: await connector.notice({ text: `notice ${index}`, appendId: `budget-mixed-${index}` });
				}
				equal(last?.status, "pending", "the call that found the minute spent");
				equal(mason.submissions.length + mason.notices.length, limit, "calls the fake mason accepted");
				// A budget is a verdict, not a broken link: the connector keeps the socket it was refused on.
				equal(mason.connected, true, "the link the refusal came over");
			},
		},
		{
			name: "journal/a call made with no link is sent once the link is back",
			needs: ["owner"],
			async run({ mason, connector }) {
				mason.kill("the link went away");
				const outcome = await connector.submit({
					content: [{ type: "text", text: "while you were out" }],
					appendId: "journaled-1",
				});
				if (outcome.status === "refused") fail("journal", `the call was refused: ${outcome.code}`);
				await waitFor(() => mason.submissions.length === 1, "the journaled call was replayed", 2_000);
				equal(mason.submissions[0]?.appendId, "journaled-1", "the id the replay carried");
			},
		},
		{
			name: "attachments/an upload comes back as a content id",
			async run({ connector }) {
				const bytes = new Uint8Array([1, 2, 3, 4]);
				const uploaded = await connector.attachments.upload(bytes, {
					mimeType: "application/octet-stream",
					name: "a.bin",
				});
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
				equal(
					mason.attachmentPosts(),
					before,
					"uploads that reached mason: the cap is the client's, before a byte",
				);
			},
		},
	];
}
