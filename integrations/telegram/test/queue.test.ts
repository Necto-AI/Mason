/**
 * Outbound sends: the per-chat window, and a 429 honoured rather than retried into a longer ban.
 *
 * Time is a number this test owns, so a minute of throttling costs nothing and every wait is asserted exactly. What is
 * being pinned is the shape of the promise the agent gets: twenty a minute per chat, in order, and an outcome that says
 * what happened instead of a hang.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SendQueue } from "../src/queue.ts";
import type { SendOutcome } from "../src/telegram.ts";

interface Rig {
	readonly queue: SendQueue;
	readonly sleeps: number[];
	readonly waits: string[];
	clock(): number;
}

function rig(options: { limit?: number; maxWaitMs?: number } = {}): Rig {
	let now = 0;
	const sleeps: number[] = [];
	const waits: string[] = [];
	const queue = new SendQueue({
		now: () => now,
		sleep: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
		onWait: (chatId, waitMs, reason) => waits.push(`${chatId}:${reason}:${waitMs}`),
		...(options.limit === undefined ? {} : { limit: options.limit }),
		...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
	});
	return { queue, sleeps, waits, clock: () => now };
}

function sent(messageId: number): SendOutcome {
	return { kind: "sent", messageId };
}

describe("the per-chat window", () => {
	it("sends twenty in a minute without waiting", async () => {
		const { queue, sleeps, clock } = rig();
		for (let index = 0; index < 20; index += 1) {
			assert.deepEqual(await queue.enqueue("-1001234", async () => sent(index)), sent(index));
			assert.equal(clock(), 0);
		}
		assert.deepEqual(sleeps, []);
	});

	it("holds the twenty-first until the oldest send leaves the window", async () => {
		const { queue, sleeps, waits } = rig();
		for (let index = 0; index < 20; index += 1) await queue.enqueue("-1001234", async () => sent(index));

		const outcome = await queue.enqueue("-1001234", async () => sent(20));

		assert.deepEqual(outcome, sent(20));
		assert.deepEqual(sleeps, [60_000]);
		assert.deepEqual(waits, ["-1001234:rate:60000"]);
	});

	it("does not make one chat wait for another", async () => {
		const { queue, sleeps } = rig({ limit: 1 });
		await queue.enqueue("-1001234", async () => sent(1));
		// The first chat has spent its single slot; another chat's message still goes out immediately.
		await queue.enqueue("-2000000", async () => sent(2));
		assert.deepEqual(sleeps, []);
	});

	it("keeps one chat's sends in the order they were queued", async () => {
		const { queue } = rig();
		const order: string[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = queue.enqueue("-1001234", async () => {
			order.push("first");
			await gate;
			return sent(1);
		});
		const second = queue.enqueue("-1001234", async () => {
			order.push("second");
			return sent(2);
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(order, ["first"]);
		release();
		await Promise.all([first, second]);
		assert.deepEqual(order, ["first", "second"]);
	});
});

describe("a 429 from Telegram", () => {
	it("waits exactly the retry_after it was given, then sends once more", async () => {
		const { queue, sleeps, waits } = rig();
		let attempts = 0;

		const outcome = await queue.enqueue("-1001234", async () => {
			attempts += 1;
			return attempts === 1 ? { kind: "throttled", retryAfter: 7 } : sent(42);
		});

		assert.deepEqual(outcome, sent(42));
		assert.equal(attempts, 2);
		assert.deepEqual(sleeps, [7_000]);
		assert.deepEqual(waits, ["-1001234:throttled:7000"]);
	});

	it("stops after three retries and reports the throttle instead of looping", async () => {
		const { queue, sleeps } = rig();
		let attempts = 0;

		const outcome = await queue.enqueue("-1001234", async () => {
			attempts += 1;
			return { kind: "throttled", retryAfter: 3 };
		});

		assert.equal(attempts, 4);
		assert.deepEqual(sleeps, [3_000, 3_000, 3_000]);
		assert.deepEqual(outcome, {
			kind: "failed",
			error: "Telegram is throttling this chat (3 s) after 3 retries",
		});
	});

	it("gives up rather than holding a tool call open past its limit", async () => {
		const { queue, sleeps } = rig({ maxWaitMs: 30_000 });

		const outcome = await queue.enqueue("-1001234", async () => ({ kind: "throttled", retryAfter: 3_600 }));

		assert.deepEqual(sleeps, []);
		assert.equal(outcome.kind, "failed");
		assert.match(outcome.kind === "failed" ? outcome.error : "", /asked for a 3600 s wait/);
	});

	it("passes a plain failure through without retrying it", async () => {
		const { queue, sleeps } = rig();
		let attempts = 0;

		const outcome = await queue.enqueue("-1001234", async () => {
			attempts += 1;
			return { kind: "failed", error: "400 Bad Request: chat not found" };
		});

		assert.equal(attempts, 1);
		assert.deepEqual(sleeps, []);
		assert.deepEqual(outcome, { kind: "failed", error: "400 Bad Request: chat not found" });
	});

	it("turns an attempt that threw into a failed outcome rather than a broken queue", async () => {
		const { queue } = rig();

		const outcome = await queue.enqueue("-1001234", async () => {
			throw new Error("fetch exploded");
		});

		assert.deepEqual(outcome, { kind: "failed", error: "fetch exploded" });
		assert.deepEqual(await queue.enqueue("-1001234", async () => sent(9)), sent(9));
	});

	it("takes the bot token out of a thrown error before it becomes a tool result", async () => {
		const token = "123456789:AAHk9_" + "x".repeat(30);
		const withSecrets = new SendQueue({ secrets: [token] });

		const outcome = await withSecrets.enqueue("-1001234", async () => {
			throw new Error(`request to https://api.telegram.org/bot${token}/sendMessage failed`);
		});

		assert.equal(outcome.kind, "failed");
		const error = outcome.kind === "failed" ? outcome.error : "";
		assert.doesNotMatch(error, new RegExp(token));
		assert.match(error, /\/bot<redacted>\/sendMessage/);
	});
});
