/**
 * Hook fire identity, and arming.
 *
 * A fire has an identity and the caller owns it, because only the caller knows what "the same event" means: a sender
 * that names its delivery is exact and permanent, a sender that cannot is one event per body per window, a schedule is
 * one fire per slot, and a gesture is a fire of its own. The key builders are pinned here as pure functions, and the
 * durable consequence — a second fire with a known key adds no submission — is pinned against the real conversation,
 * whose `requestId` dedupe is what makes any of it true.
 *
 * Arming is here too: `start()` walks every hook it knows, including the ones nobody enabled, and `#arm` is the single
 * gate that keeps them quiet.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
	BODY_DEDUPE_WINDOW_MS,
	bodyRequestId,
	explicitRequestId,
	HooksManager,
	scheduledRequestId,
} from "../src/server/hooks.ts";
import { openAgentRuntime, type AgentRuntime } from "../src/server/runtime.ts";

/** A clock the test moves by hand: fire identity is about time, so time is an input here, not a wait. */
interface TestClock {
	now(): Date;
	at(): number;
	advance(ms: number): void;
}

/** Half a second past a minute boundary: inside one `BODY_DEDUPE_WINDOW_MS` window with room on both sides. */
const ALIGNED_START = "2026-10-19T09:00:00.500Z";

function testClock(startIso: string): TestClock {
	let nowMs = Date.parse(startIso);
	return {
		now: () => new Date(nowMs),
		at: () => nowMs,
		advance: (ms) => {
			nowMs += ms;
		},
	};
}

/** A manager that never submits: enough for `define()` and for building keys. */
function managerWithClock(clock: TestClock): HooksManager {
	return new HooksManager({
		conversation: async () => {
			throw new Error("this manager only defines hooks");
		},
		now: clock.now,
	});
}

/** What every identity test fires. No interval: nothing schedules it, so only the test's own calls submit. */
const digest = {
	id: "digest",
	name: "Digest",
	description: "A digest an external sender fires.",
	enabled: false,
	promptTemplate: "digest: {{payload}}",
};

/** The same hook on an hourly schedule, for the slot key. */
const hourlyDigest = { ...digest, intervalMs: 60 * 60 * 1_000 };

/**
 * A hooks manager over a real conversation, on a clock the test drives. pi-durable's admission is the dedupe: a known
 * request id returns the submission it already made and writes nothing, so "one submission" here means one `app.hook`
 * entry in the transcript.
 */
async function withFiringManager(
	run: (hooks: HooksManager, runtime: AgentRuntime, clock: TestClock) => Promise<void>,
): Promise<void> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 8 }, (_, index) => fauxAssistantMessage(fauxText(`answer ${index}`))));
	const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
		storage: "memory",
		modelAccess: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true },
		onReport: () => {},
	});
	const clock = testClock(ALIGNED_START);
	const hooks = new HooksManager({ conversation: () => runtime.conversation(), now: clock.now });
	hooks.define(digest);
	try {
		await run(hooks, runtime, clock);
	} finally {
		await hooks.close();
		await runtime.close();
	}
}

async function hookEntryCount(runtime: AgentRuntime): Promise<number> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return page.items.filter((entry) => entry.kind === "app.hook").length;
}

async function withRuntime(run: (runtime: AgentRuntime) => Promise<void>): Promise<void> {
	const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
		storage: "memory",
		faux: true,
		onReport: () => {},
	});
	try {
		await run(runtime);
	} finally {
		await runtime.close();
	}
}

describe("a fire's identity", () => {
	it("is the sender's own id when it names one: exact, and it never ages out", async () => {
		await withFiringManager(async (hooks, runtime, clock) => {
			const requestId = explicitRequestId("digest", "delivery-7");
			const first = await hooks.fire("digest", { payload: "a", requestId });
			await first.wait(BACKGROUND_CONTEXT);

			// Three days later, the same delivery id: still the same event, however far behind the sender's queue is.
			clock.advance(3 * 24 * 60 * 60 * 1_000);
			const again = await hooks.fire("digest", { payload: "a", requestId });
			assert.equal(again.id, first.id, "the same delivery is the same submission");
			assert.equal(await hookEntryCount(runtime), 1);
			assert.equal(hooks.get("digest")?.fireCount, 2, "a fire a known key collapsed still counts as an attempt");

			// Another delivery id is another event, even with an identical payload.
			const other = await hooks.fire("digest", { payload: "a", requestId: explicitRequestId("digest", "delivery-8") });
			await other.wait(BACKGROUND_CONTEXT);
			assert.notEqual(other.id, first.id);
			assert.equal(await hookEntryCount(runtime), 2);
		});
	});

	it("is the body per window when the sender cannot name it: replays collapse, the next window fires", async () => {
		await withFiringManager(async (hooks, runtime, clock) => {
			const body = { message: "anything new?", tags: ["daily"] };
			const first = await hooks.fire("digest", { requestId: bodyRequestId("digest", body, clock.at()) });
			await first.wait(BACKGROUND_CONTEXT);

			// A redelivery of the same bytes, seconds later: one event, one turn.
			clock.advance(BODY_DEDUPE_WINDOW_MS - 1_000);
			const replay = await hooks.fire("digest", { requestId: bodyRequestId("digest", body, clock.at()) });
			assert.equal(replay.id, first.id);
			assert.equal(await hookEntryCount(runtime), 1);

			// The next window: the same digest is news again, because a bucket is not a body hash remembered forever.
			clock.advance(2_000);
			const next = await hooks.fire("digest", { requestId: bodyRequestId("digest", body, clock.at()) });
			await next.wait(BACKGROUND_CONTEXT);
			assert.notEqual(next.id, first.id);
			assert.equal(await hookEntryCount(runtime), 2);
		});
	});

	it("gives one key per schedule slot, so a re-arm cannot double-fire", async () => {
		const clock = testClock(ALIGNED_START);
		const slotStart = clock.at();
		assert.equal(
			scheduledRequestId(hourlyDigest, slotStart),
			scheduledRequestId(hourlyDigest, slotStart + 59 * 60 * 1_000),
			"every fire inside the slot is the same fire",
		);
		assert.notEqual(
			scheduledRequestId(hourlyDigest, slotStart + 59 * 60 * 1_000),
			scheduledRequestId(hourlyDigest, slotStart + 60 * 60 * 1_000),
			"the next slot fires again",
		);
		await withFiringManager(async (hooks, runtime, window) => {
			const first = await hooks.fire("digest", { requestId: scheduledRequestId(hourlyDigest, window.at()) });
			await first.wait(BACKGROUND_CONTEXT);
			// A second arm of the same timer, inside the slot: the slot is already spent.
			const rearm = await hooks.fire("digest", { requestId: scheduledRequestId(hourlyDigest, window.at()) });
			assert.equal(rearm.id, first.id);
			assert.equal(await hookEntryCount(runtime), 1);
		});
	});

	it("is fresh for a gesture, so a click is an intent and two clicks are two fires", async () => {
		await withFiringManager(async (hooks, runtime) => {
			// Both fires share one frozen millisecond: the manager's own sequence keeps them apart.
			const first = await hooks.fire("digest", { payload: "retry" });
			await first.wait(BACKGROUND_CONTEXT);
			const second = await hooks.fire("digest", { payload: "retry" });
			await second.wait(BACKGROUND_CONTEXT);
			assert.notEqual(second.id, first.id);
			assert.equal(await hookEntryCount(runtime), 2);
			assert.equal(hooks.get("digest")?.fireCount, 2);
		});
	});

	it("hashes a body's meaning, not its key order or its array placeholders", () => {
		const nowMs = Date.parse(ALIGNED_START);
		assert.equal(
			bodyRequestId("digest", { a: 1, b: [1, 2] }, nowMs),
			bodyRequestId("digest", { b: [1, 2], a: 1 }, nowMs),
			"JSON objects are unordered",
		);
		assert.notEqual(
			bodyRequestId("digest", { a: [1, 2] }, nowMs),
			bodyRequestId("digest", { a: [2, 1] }, nowMs),
			"array order is part of the body",
		);
		assert.notEqual(bodyRequestId("digest", { a: 1 }, nowMs), bodyRequestId("other", { a: 1 }, nowMs), "per hook");
	});
});

describe("a hook's authoring rule", () => {
	it("warns when it fires inside the body-dedupe window, and is quiet above it", () => {
		const warnings: string[] = [];
		const warn = console.warn;
		console.warn = (message: string) => {
			warnings.push(message);
		};
		try {
			const hooks = managerWithClock(testClock(ALIGNED_START));
			hooks.define({ ...digest, id: "fast", intervalMs: BODY_DEDUPE_WINDOW_MS - 1 });
			assert.equal(warnings.length, 1, "a hook faster than the dedupe window is warned about");
			assert.match(warnings[0] ?? "", /body-dedupe window/);
			hooks.define({ ...digest, id: "slow", intervalMs: BODY_DEDUPE_WINDOW_MS });
			hooks.define({ ...digest, id: "manual" });
			assert.equal(warnings.length, 1, "at the window, and with no interval at all, there is nothing to warn about");
		} finally {
			console.warn = warn;
		}
	});
});

// These two run a sub-minute interval so arming is observable — `define()` warns about that rate, by design.
describe("a disabled hook", () => {
	it("is not armed by startup walking every hook", async () => {
		await withRuntime(async (runtime) => {
			runtime.hooks.define({
				id: "tick",
				name: "Tick",
				description: "A one-second hook that nobody enabled.",
				enabled: false,
				intervalMs: 1_000,
				promptTemplate: "tick",
			});
			runtime.hooks.start();
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			assert.equal(runtime.hooks.get("tick")?.fireCount, 0);
		});
	});

	it("starts firing once it is enabled", async () => {
		await withRuntime(async (runtime) => {
			runtime.hooks.define({
				id: "tick",
				name: "Tick",
				description: "A one-second hook that is enabled later.",
				enabled: false,
				intervalMs: 1_000,
				promptTemplate: "tick",
			});
			runtime.hooks.setEnabled("tick", true);
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			assert.ok((runtime.hooks.get("tick")?.fireCount ?? 0) >= 1);
		});
	});
});
