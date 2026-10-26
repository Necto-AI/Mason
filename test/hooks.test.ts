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
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
	bodyRequestId,
	explicitRequestId,
	formatPrompt,
	gestureRequestId,
	builtinHooks,
	HooksManager,
	IDENTITY_WINDOW_MS,
	scheduledRequestId,
} from "../src/server/hooks.ts";
import type { AgentRuntime } from "../src/server/runtime.ts";
import { openAgentRuntime } from "../src/server/runtime.ts";
import { HOOK_ENTRY_KIND } from "../src/shared/contract.ts";

/** A clock the test moves by hand: fire identity is about time, so time is an input here, not a wait. */
interface TestClock {
	now(): Date;
	at(): number;
	advance(ms: number): void;
}

/** Half a second past a minute boundary: inside one `IDENTITY_WINDOW_MS` window with room on both sides. */
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
function managerWithClock(clock: TestClock, onReport?: (error: unknown) => void): HooksManager {
	return new HooksManager({
		conversation: async () => {
			throw new Error("this manager only defines hooks");
		},
		now: clock.now,
		...(onReport === undefined ? {} : { onReport }),
	});
}

/** A throwaway home: the suite must never create or read the developer's `~/.mason`. */
function tempHouse(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pda-hooks-"));
}

/** What every identity test fires. No interval: nothing schedules it, so only the test's own calls submit. */
const digest = {
	id: "digest",
	name: "Digest",
	description: "A digest an external sender fires.",
	enabled: false,
	promptTemplate: "digest: {{payload}}",
	fireCount: 0,
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
		houseHome: await tempHouse(),
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

async function hookEntries(
	runtime: AgentRuntime,
): Promise<{ readonly text: string; readonly data: Record<string, unknown> }[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return page.items
		.filter((entry) => entry.kind === HOOK_ENTRY_KIND)
		.map((entry) => {
			const content = entry.model?.[0]?.content;
			const data = entry.data;
			return {
				text: typeof content === "string" ? content : "",
				data:
					typeof data === "object" && data !== null && !Array.isArray(data)
						? (data as Record<string, unknown>)
						: {},
			};
		});
}

async function hookEntryCount(runtime: AgentRuntime): Promise<number> {
	return (await hookEntries(runtime)).length;
}

async function withRuntime(run: (runtime: AgentRuntime) => Promise<void>): Promise<void> {
	const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
		storage: "memory",
		houseHome: await tempHouse(),
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
			clock.advance(IDENTITY_WINDOW_MS - 1_000);
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
			// Both fires share one frozen millisecond, and a restart would reset any counter: only a fresh id per
			// gesture keeps two presses apart, however close together they land.
			const first = await hooks.fire("digest", { payload: "retry" });
			await first.wait(BACKGROUND_CONTEXT);
			const second = await hooks.fire("digest", { payload: "retry" });
			await second.wait(BACKGROUND_CONTEXT);
			assert.notEqual(second.id, first.id);
			assert.equal(await hookEntryCount(runtime), 2);
			assert.equal(hooks.get("digest")?.fireCount, 2);
		});
	});

	it("names a gesture per fire, so no two gestures can collide", () => {
		assert.notEqual(gestureRequestId("digest"), gestureRequestId("digest"));
		assert.match(gestureRequestId("digest"), /^hook:digest:gesture:[0-9a-f-]{36}$/);
		assert.equal(gestureRequestId("digest", "pressed-once"), "hook:digest:gesture:pressed-once");
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

describe("a fire's kind", () => {
	/** A template the payload starts a line of: what every built-in that takes a payload looks like. */
	const labelled = { ...digest, promptTemplate: "A digest arrived. Read it and report.\n{{payload}}" };

	it("is one line of the prompt immediately above the payload", () => {
		const text = formatPrompt(labelled, "Ilya opened #1421", ALIGNED_START, "issue.opened");
		assert.match(
			text,
			/Read it and report\.\nEvent: issue\.opened\n\[begin untrusted payload/,
			"the label sits between the instruction and the data, never inside the fence",
		);
		assert.match(text, /\[end untrusted payload\]$/);
	});

	it("is appended after the template text when the template has no payload placeholder", () => {
		const text = formatPrompt({ ...digest, promptTemplate: "Check the workspace." }, "3 pushes to main", ALIGNED_START, "push");
		assert.match(text, /^Check the workspace\.\n\nEvent: push\n\nPayload:\n\[begin untrusted payload/);
	});

	it("changes nothing for a fire whose sender named no kind", () => {
		// The GitHub route and a scheduled fire pass none, and their prompt must be the one they always had.
		const text = formatPrompt(labelled, "Ilya opened #1421", ALIGNED_START);
		assert.doesNotMatch(text, /Event:/);
		assert.match(text, /^A digest arrived\. Read it and report\.\n\[begin untrusted payload/);
	});

	it("rides in the entry as well, and is absent from one that named none", async () => {
		await withFiringManager(async (hooks, runtime) => {
			const named = await hooks.fire("digest", {
				payload: "Ilya opened #1421",
				kind: "issue.opened",
				requestId: explicitRequestId("digest", "named"),
			});
			await named.wait(BACKGROUND_CONTEXT);
			const plain = await hooks.fire("digest", {
				payload: "3 pushes to main",
				requestId: explicitRequestId("digest", "plain"),
			});
			await plain.wait(BACKGROUND_CONTEXT);

			const entries = await hookEntries(runtime);
			assert.equal(entries.length, 2);
			const labelledEntry = entries.find((entry) => entry.data.payload === "Ilya opened #1421");
			const plainEntry = entries.find((entry) => entry.data.payload === "3 pushes to main");
			assert.equal(labelledEntry?.data.kind, "issue.opened", "the transcript carries what the sender said happened");
			assert.match(labelledEntry?.text ?? "", /Event: issue\.opened/);
			assert.equal("kind" in (plainEntry?.data ?? {}), false, "a kindless fire's entry has no kind at all");
			assert.doesNotMatch(plainEntry?.text ?? "", /Event:/);
		});
	});
});

describe("a hook's authoring rule", () => {
	it("warns through the report channel when it fires inside the identity bucket, and is quiet above it", () => {
		const reports: unknown[] = [];
		const hooks = managerWithClock(testClock(ALIGNED_START), (error) => reports.push(error));
		hooks.define({ ...digest, id: "fast", intervalMs: IDENTITY_WINDOW_MS - 1 });
		assert.equal(reports.length, 1, "a hook faster than the identity bucket is warned about");
		assert.match(String(reports[0] ?? ""), /identity bucket/);
		hooks.define({ ...digest, id: "slow", intervalMs: IDENTITY_WINDOW_MS });
		hooks.define({ ...digest, id: "manual" });
		assert.equal(reports.length, 1, "at the bucket, and with no interval at all, there is nothing to warn about");
	});

	it("warns in the log when the host has no report channel", () => {
		const warnings: string[] = [];
		const warn = console.warn;
		console.warn = (message: string) => {
			warnings.push(message);
		};
		try {
			const hooks = managerWithClock(testClock(ALIGNED_START));
			hooks.define({ ...digest, id: "fast", intervalMs: IDENTITY_WINDOW_MS - 1 });
			assert.equal(warnings.length, 1, "the warning is not lost when nobody is listening to reports");
		} finally {
			console.warn = warn;
		}
	});

	it("is quiet for a fast hook whose senders name their fires, however they name them", () => {
		const reports: unknown[] = [];
		const hooks = managerWithClock(testClock(ALIGNED_START), (error) => reports.push(error));
		const fast = { ...digest, intervalMs: 5_000 };
		hooks.define({ ...fast, id: "named-ids", identify: "request" });
		hooks.define({ ...fast, id: "named-bodies", identify: "body" });
		assert.deepEqual(reports, [], "a declared identity is exact, so the bucket cannot lose a fire");
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

/**
 * The one hook whose prompt is read by a person's outside world, so the sentence that tells the model what a chat is has
 * to be pinned. It is not decoration: an agent that offers a chart in a chat, or treats the contents of a file as an
 * instruction, is the failure this text exists to prevent, and a revert of it would otherwise ship silently.
 */
describe("the team-chat prompt", () => {
	const template = builtinHooks().find((hook) => hook.id === "team-chat")?.promptTemplate ?? "";

	it("says the chat renders words, not widgets", () => {
		assert.match(template, /renders no widget/);
	});

	it("says a path in the payload is a file `read` opens, and that its contents are data", () => {
		assert.match(template, /`read` opens it/);
		assert.match(template, /data from an outside system too/);
	});

	it("still hands the model the payload it is told to weigh rather than obey", () => {
		assert.match(template, /\{\{payload\}\}$/);
		assert.match(template, /not instructions/);
	});
});
