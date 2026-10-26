/**
 * The typing indicator: the heartbeat a chat shows while a turn is running.
 *
 * Time and timers are this test's, so a three-minute turn costs nothing and every ping is counted exactly. What is
 * pinned is the promise the interface makes: dots start when a fire is accepted, they keep coming rather than flashing
 * once, they stop when an answer lands or when the window expires, and a ping that fails is a log line rather than a
 * broken poll loop.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TypingIndicator, TYPING_MAX_MS } from "../src/typing.ts";

interface Rig {
	readonly typing: TypingIndicator;
	readonly pings: string[];
	readonly warnings: string[];
	clock(): number;
	advance(ms: number): void;
	tick(): void;
	running(): boolean;
	failNext(error?: Error): void;
}

/** One macrotask, so a fire-and-forget ping has run far enough to log or not. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function rig(): Rig {
	let now = 0;
	let callback: (() => void) | undefined;
	const handle = { timer: true };
	const pings: string[] = [];
	const warnings: string[] = [];
	let failure: Error | undefined;
	const typing = new TypingIndicator({
		ping: async (chatId) => {
			if (failure !== undefined) {
				const thrown = failure;
				failure = undefined;
				throw thrown;
			}
			pings.push(chatId);
		},
		log: (level, line) => {
			if (level === "warn" || level === "error") warnings.push(line);
		},
		now: () => now,
		timers: {
			setInterval: (callback_: () => void) => {
				callback = callback_;
				return handle;
			},
			clearInterval: (cleared) => {
				if (cleared === handle) callback = undefined;
			},
		},
	});
	return {
		typing,
		pings,
		warnings,
		clock: () => now,
		advance: (ms) => {
			now += ms;
		},
		tick: () => callback?.(),
		running: () => callback !== undefined,
		failNext: (error) => {
			failure = error ?? new Error("no");
		},
	};
}

describe("the typing indicator", () => {
	it("pings at once, and again on every refresh while the chat is busy", () => {
		const { typing, pings, tick, running } = rig();
		typing.start("-1001234");
		assert.deepEqual(pings, ["-1001234"], "the first ping is what makes the dots appear at all");
		assert.equal(running(), true);
		tick();
		tick();
		assert.deepEqual(pings, ["-1001234", "-1001234", "-1001234"]);
	});

	it("stops when an answer lands, and stops the timer with it", () => {
		const { typing, pings, tick, running } = rig();
		typing.start("-1001234");
		typing.stop("-1001234");
		assert.equal(running(), false, "no chat is typing, so nothing should be waking up to say so");
		tick();
		assert.deepEqual(pings, ["-1001234"], "the send itself is what the reader sees next, not another ping");
	});

	it("stops one chat without touching another", () => {
		const { typing, pings, tick, running } = rig();
		typing.start("-1001");
		typing.start("-1002");
		typing.stop("-1001");
		assert.equal(running(), true, "one chat is still being worked on");
		tick();
		assert.deepEqual(pings, ["-1001", "-1002", "-1002"]);
		assert.deepEqual(typing.typing, ["-1002"]);
	});

	it("gives up on its own, because a turn can end without a send", () => {
		const { typing, pings, advance, tick, running } = rig();
		typing.start("-1001234");
		advance(TYPING_MAX_MS - 1);
		tick();
		assert.equal(pings.length, 2, "still inside the window");
		advance(1);
		tick();
		assert.equal(running(), false, "the window closed and the dots are Telegram's to clear");
		assert.deepEqual(typing.typing, []);
	});

	it("renews the window when a second message arrives in the same chat", () => {
		const { typing, advance, tick, pings } = rig();
		typing.start("-1001234");
		advance(TYPING_MAX_MS - 1);
		typing.start("-1001234");
		advance(TYPING_MAX_MS - 1);
		tick();
		assert.equal(pings.length, 3, "two starts and one heartbeat, because the second message restarted the clock");
		assert.deepEqual(typing.typing, ["-1001234"]);
	});

	it("warns once about a ping that fails, and keeps the heartbeat going", async () => {
		const { typing, pings, warnings, tick, failNext, running } = rig();
		failNext(new Error("ECONNREFUSED"));
		typing.start("-1001234");
		await settle();
		assert.equal(warnings.length, 1);
		assert.equal(running(), true, "a failed courtesy is not a failed turn");
		tick();
		await settle();
		assert.deepEqual(pings, ["-1001234"]);
		assert.equal(warnings.length, 1, "one line per chat, not one every four seconds");
	});

	it("clears everything on stopAll, which is how a container stops", () => {
		const { typing, tick, pings, running } = rig();
		typing.start("-1001");
		typing.start("-1002");
		typing.stopAll();
		assert.equal(running(), false);
		tick();
		assert.equal(pings.length, 2);
		assert.deepEqual(typing.typing, []);
	});
});
