/**
 * The trigger face's memory: first boot starts from now, a restart resumes, a refused delivery moves on, and a door
 * that could not take a message — unreachable, or answering something that is no verdict — leaves the batch exactly where
 * it was.
 *
 * The state here is a real directory — `StateFiles` is half of what is being tested — while Telegram and the door are
 * scripted, so each test is one sequence of answers rather than a mock of the process.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ChatDirectory } from "../src/chats.ts";
import type { DoorResult } from "../src/door.ts";
import type { EventEnvelope } from "../src/envelope.ts";
import { createLog } from "../src/log.ts";
import { Poller, type EventSink, type UpdateSource } from "../src/poller.ts";
import { StateFiles } from "../src/state.ts";
import type { TelegramUpdate } from "../src/telegram.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** What the poller asked for, in order, so `offset` and `timeout` are assertions rather than assumptions. */
class ScriptedUpdates implements UpdateSource {
	readonly calls: { offset: number | undefined; timeout: number }[] = [];
	readonly #batches: TelegramUpdate[][];

	constructor(batches: TelegramUpdate[][]) {
		this.#batches = [...batches];
	}

	async getUpdates(options: { offset?: number; timeout: number }): Promise<TelegramUpdate[]> {
		this.calls.push({ offset: options.offset, timeout: options.timeout });
		return this.#batches.shift() ?? [];
	}
}

class RecordingDoor implements EventSink {
	readonly envelopes: EventEnvelope[] = [];
	readonly #script: DoorResult[];
	readonly #answer: DoorResult;

	constructor(answer: DoorResult = { kind: "accepted" }, script: readonly DoorResult[] = []) {
		this.#answer = answer;
		this.#script = [...script];
	}

	async fire(envelope: EventEnvelope): Promise<DoorResult> {
		this.envelopes.push(envelope);
		return this.#script.shift() ?? this.#answer;
	}
}

function update(updateId: number, overrides: Record<string, unknown> = {}): TelegramUpdate {
	return {
		update_id: updateId,
		message: {
			message_id: updateId,
			date: 1_700_000_000,
			text: "ship it?",
			from: { id: 11, first_name: "Ilya", username: "ilya" },
			chat: { id: -1_001_234, type: "supergroup", title: "Team chat" },
			...overrides,
		},
	};
}

interface Rig {
	readonly state: StateFiles;
	readonly poller: Poller;
	readonly api: ScriptedUpdates;
	readonly door: RecordingDoor;
	readonly chats: ChatDirectory;
	readonly lines: string[];
	readonly directory: string;
}

async function rig(
	batches: TelegramUpdate[][],
	options: {
		readonly offset?: number;
		readonly door?: DoorResult;
		readonly chats?: ChatDirectory;
	} = {},
): Promise<Rig> {
	const directory = await mkdtemp(join(tmpdir(), "mason-telegram-"));
	directories.add(directory);
	const state = new StateFiles(directory);
	if (options.offset !== undefined) await state.writeOffset(options.offset);
	const api = new ScriptedUpdates(batches);
	const door = new RecordingDoor(options.door);
	const chats = options.chats ?? new ChatDirectory(await state.readChats());
	const lines: string[] = [];
	const poller = new Poller({
		api,
		state,
		door,
		chats,
		log: createLog([], (line) => lines.push(line)),
		filter: { allowedChats: new Set(["-1001234"]), botUsername: "mason_bot" },
	});
	return { state, poller, api, door, chats, lines, directory };
}

async function readOffset(state: StateFiles, directory: string): Promise<unknown> {
	return JSON.parse(await readFile(join(directory, "offset.json"), "utf8")) as unknown;
}

interface DownRig {
	readonly waits: number[];
	readonly lines: string[];
	readonly door: RecordingDoor;
	readonly state: StateFiles;
	readonly directory: string;
}

/**
 * One batch delivered to a door with a scripted sequence of answers, and a clock the sleeps advance — so a minute of a
 * door being down costs a test nothing, and every wait is asserted as the number it was.
 *
 * `stopAfter` aborts the poll the way `SIGTERM` does, after that many sleeps: the poller holds a batch until the door
 * answers, so a test that never lets the door answer has to say when the container stops.
 */
async function pollAgainstDoor(
	script: readonly DoorResult[],
	options: {
		readonly batches?: TelegramUpdate[][];
		readonly offset?: number;
		readonly stopAfter?: number;
	} = {},
): Promise<DownRig> {
	const directory = await mkdtemp(join(tmpdir(), "mason-telegram-"));
	directories.add(directory);
	const state = new StateFiles(directory);
	await state.writeOffset(options.offset ?? 100);
	const waits: number[] = [];
	const lines: string[] = [];
	const door = new RecordingDoor(script.at(-1) ?? { kind: "accepted" }, script);
	const controller = new AbortController();
	let clock = 0;
	const stopAfter = options.stopAfter ?? Number.POSITIVE_INFINITY;
	const poller = new Poller({
		api: new ScriptedUpdates(options.batches ?? [[update(100)]]),
		state,
		door,
		chats: new ChatDirectory(),
		log: createLog([], (line) => lines.push(line)),
		filter: { allowedChats: new Set(["-1001234"]), botUsername: "mason_bot" },
		now: () => clock,
		sleep: async (ms) => {
			waits.push(ms);
			clock += ms;
			if (waits.length >= stopAfter) controller.abort();
		},
	});
	await poller.pollOnce(controller.signal);
	return { waits, lines, door, state, directory };
}

describe("the offset on a first boot", () => {
	it("asks without an offset, discards the backlog, and remembers where it ended", async () => {
		const { poller, api, door, state, directory, lines } = await rig([[update(5), update(6)]]);

		const summary = await poller.pollOnce();

		assert.deepEqual(summary, { read: 2, fired: 0 });
		assert.deepEqual(door.envelopes, []);
		assert.deepEqual(api.calls[0], { offset: undefined, timeout: 0 });
		assert.deepEqual(await readOffset(state, directory), { offset: 7 });
		assert.match(lines.join("\n"), /first boot: discarded 2 queued update\(s\)/);
	});

	it("reads from now when there was nothing queued, and still persists a place", async () => {
		const { poller, state, directory } = await rig([[]]);

		await poller.pollOnce();

		assert.deepEqual(await readOffset(state, directory), { offset: 0 });
	});

	it("long-polls on the batch after the first, because by then there is something to wait for", async () => {
		const { poller, api } = await rig([[], [update(9)]]);

		await poller.pollOnce();
		await poller.pollOnce();

		assert.equal(api.calls[1]?.offset, 0);
		assert.equal(api.calls[1]?.timeout, 30);
	});
});

describe("the offset on a restart", () => {
	it("resumes exactly where the last batch ended", async () => {
		const { poller, api, door, state, directory } = await rig([[update(100)]], { offset: 100 });

		await poller.pollOnce();

		assert.deepEqual(api.calls, [{ offset: 100, timeout: 30 }]);
		assert.equal(door.envelopes[0]?.id, "tg-100");
		assert.deepEqual(await readOffset(state, directory), { offset: 101 });
	});

	it("advances past a message the door refused, so the chat behind it is not blocked forever", async () => {
		const { poller, door, state, directory, lines } = await rig([[update(100), update(101)]], {
			offset: 100,
			door: { kind: "refused", status: 401 },
		});

		await poller.pollOnce();

		assert.equal(door.envelopes.length, 2);
		assert.deepEqual(await readOffset(state, directory), { offset: 102 });
		assert.doesNotMatch(lines.join("\n"), /poll failed/);
	});

	it("does not advance past a door it could not reach, and holds the same batch", async () => {
		const down = await pollAgainstDoor(
			[
				{ kind: "unreachable", error: "connect ECONNREFUSED" },
				{ kind: "unreachable", error: "connect ECONNREFUSED" },
				{ kind: "accepted" },
			],
		);

		assert.deepEqual(await readOffset(down.state, down.directory), { offset: 101 });
		// Three posts of one message, because an update id that never reached the door is never seen again.
		assert.deepEqual(
			down.door.envelopes.map((envelope) => envelope.id),
			["tg-100", "tg-100", "tg-100"],
		);
		assert.deepEqual(down.waits, [1_000, 2_000]);
		assert.match(down.lines.join("\n"), /the door is answering again after 2 attempt\(s\); resuming at update 100/);
	});

	it("keeps the whole batch when the door is down, so the update after it is not skipped either", async () => {
		const down = await pollAgainstDoor(
			[
				{ kind: "accepted" },
				{ kind: "unreachable", error: "the door answered 429 with a 3600s wait" },
				{ kind: "accepted" },
				{ kind: "accepted" },
			],
			{ batches: [[update(100), update(101)]], offset: 100 },
		);

		assert.deepEqual(down.door.envelopes.map((envelope) => envelope.id), ["tg-100", "tg-101", "tg-101"]);
		assert.deepEqual(await readOffset(down.state, down.directory), { offset: 102 });
	});

	it("logs at most once a minute while the door is down, and never once a second", async () => {
		const down = await pollAgainstDoor([{ kind: "unreachable", error: "connect ECONNREFUSED" }], { stopAfter: 7 });

		const complaints = down.lines.filter((line) => line.includes("the door did not take update"));
		assert.equal(complaints.length, 2);
		assert.equal(down.door.envelopes.length, 7);
		// 1 s doubling to a half-minute ceiling: the seventh wait already crosses the minute the log is kept to.
		assert.deepEqual(down.waits, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
		assert.deepEqual(await readOffset(down.state, down.directory), { offset: 100 });
	});

	it("names the update and the reason in one line, without calling a 5xx unreachable", async () => {
		const down = await pollAgainstDoor(
			[
				{ kind: "unreachable", error: "the door answered 500: the integration's hook is not a hook" },
				{ kind: "accepted" },
			],
			{ stopAfter: 1 },
		);

		assert.deepEqual(
			down.lines.filter((line) => line.includes("did not take update")),
			[
				"[telegram] warn: the door did not take update 100 (the door answered 500: the integration's hook is not a hook); " +
					"holding the batch rather than advancing past it",
			],
		);
	});

	it("advances past a message the filter dropped", async () => {
		const { poller, door, state, directory } = await rig([[update(100), update(101)]], { offset: 100 });

		await poller.pollOnce();

		assert.deepEqual(await readOffset(state, directory), { offset: 102 });
		assert.equal(door.envelopes.length, 2);
	});
});

describe("the chat list", () => {
	it("records a chat that spoke for the first time beside the offset", async () => {
		const { poller, state, directory } = await rig([[update(100)]], { offset: 100 });

		await poller.pollOnce();

		assert.deepEqual(await state.readChats(), [{ id: "-1001234", title: "Team chat", type: "supergroup" }]);
		assert.deepEqual(await readOffset(state, directory), { offset: 101 });
	});

	it("does not grow for a chat that spoke before", async () => {
		const chats = new ChatDirectory([{ id: "-1001234", title: "Team chat", type: "supergroup" }]);
		const { poller } = await rig([[update(100)]], { offset: 100, chats });

		await poller.pollOnce();

		assert.equal(chats.list().length, 1);
		assert.equal(chats.dirty, false);
	});
});

describe("a poll that fails", () => {
	it("waits the retry_after Telegram sent and says why", async () => {
		const waitFor: number[] = [];
		const api: UpdateSource = {
			getUpdates: async () => {
				const error = new (await import("../src/telegram.ts")).TelegramError("getUpdates", 429, "Too Many", 2);
				throw error;
			},
		};
		const directory = await mkdtemp(join(tmpdir(), "mason-telegram-"));
		directories.add(directory);
		const state = new StateFiles(directory);
		await state.writeOffset(5);
		const lines: string[] = [];
		const controller = new AbortController();
		const poller = new Poller({
			api,
			state,
			door: new RecordingDoor(),
			chats: new ChatDirectory(),
			log: createLog([], (line) => lines.push(line)),
			filter: { allowedChats: new Set(["-1001234"]), botUsername: "mason_bot" },
			sleep: async (ms) => {
				waitFor.push(ms);
				controller.abort();
			},
		});

		await poller.run(controller.signal);

		assert.deepEqual(waitFor, [2_000]);
		assert.match(lines.join("\n"), /poll failed: Telegram getUpdates failed \(429\): Too Many; retrying in 2s/);
	});
});
