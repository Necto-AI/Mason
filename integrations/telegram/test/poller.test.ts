/**
 * The trigger face's memory: first boot starts from now, a restart resumes, a refused delivery moves on, and a door
 * that could not take a message — unreachable, or answering something that is no verdict — leaves the batch exactly where
 * it was.
 *
 * The state here is a real directory — `StateFiles` is half of what is being tested — while Telegram, the door and the
 * inbox are scripted, so each test is one sequence of answers rather than a mock of the process.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ChatDirectory } from "../src/chats.ts";
import { HELP_TEXT } from "../src/commands.ts";
import type { DoorAnswer, DoorResult } from "../src/door.ts";
import type { EventEnvelope, EventFile } from "../src/envelope.ts";
import type { Attachment } from "../src/filter.ts";
import type { SaveOutcome } from "../src/inbox.ts";
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

	constructor(answer: DoorResult = ACCEPTED, script: readonly DoorResult[] = []) {
		this.#answer = answer;
		this.#script = [...script];
	}

	async fire(envelope: EventEnvelope): Promise<DoorResult> {
		this.envelopes.push(envelope);
		return this.#script.shift() ?? this.#answer;
	}
}

/** An accepted answer, as a message's `202` is: nothing was handled, and there is no line to post. */
const ACCEPTED: DoorResult = { kind: "accepted", answer: { handled: false, reply: undefined } };

/** An accepted answer to a command mason ran, and the line it wants posted. */
function handled(reply: string): DoorResult {
	const answer: DoorAnswer = { handled: true, reply };
	return { kind: "accepted", answer };
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

/** The same message, carrying a PDF and no words. */
function documentUpdate(updateId: number): TelegramUpdate {
	return update(updateId, {
		text: undefined,
		document: { file_id: "f1", file_unique_id: "u1", file_name: "report.pdf", file_size: 4_096 },
	});
}

/** What the door is told, from an inbox that answered the same thing every time: saving is `src/inbox.ts`'s test. */
class StubInbox {
	readonly saved: { attachment: Attachment; updateId: number }[] = [];
	readonly #answer: SaveOutcome | Error;

	constructor(answer: SaveOutcome | Error) {
		this.#answer = answer;
	}

	async save(attachment: Attachment, options: { readonly updateId: number }): Promise<SaveOutcome> {
		this.saved.push({ attachment, updateId: options.updateId });
		if (this.#answer instanceof Error) throw this.#answer;
		return this.#answer;
	}
}

interface Rig {
	readonly state: StateFiles;
	readonly poller: Poller;
	readonly api: ScriptedUpdates;
	readonly door: RecordingDoor;
	readonly chats: ChatDirectory;
	readonly lines: string[];
	readonly said: { readonly chatId: string; readonly text: string }[];
	readonly started: string[];
	readonly directory: string;
}

async function rig(
	batches: TelegramUpdate[][],
	options: {
		readonly offset?: number;
		readonly door?: DoorResult;
		/** One answer per fire, for the tests where the first delivery is not the answer the second one gets. */
		readonly script?: readonly DoorResult[];
		readonly chats?: ChatDirectory;
		readonly inbox?: StubInbox;
		/** Appended after the recording, so a test can make an answer wait the way a spent chat window does. */
		readonly reply?: (chatId: string, text: string) => Promise<void>;
	} = {},
): Promise<Rig> {
	const directory = await mkdtemp(join(tmpdir(), "mason-telegram-"));
	directories.add(directory);
	const state = new StateFiles(directory);
	if (options.offset !== undefined) await state.writeOffset(options.offset);
	const api = new ScriptedUpdates(batches);
	const door = new RecordingDoor(options.door, options.script);
	const chats = options.chats ?? new ChatDirectory(await state.readChats());
	const lines: string[] = [];
	const said: { chatId: string; text: string }[] = [];
	const started: string[] = [];
	const poller = new Poller({
		api,
		state,
		door,
		chats,
		log: createLog([], (line) => lines.push(line)),
		filter: { allowedChats: new Set(["-1001234"]), botUsername: "mason_bot" },
		reply: async (chatId, text) => {
			said.push({ chatId, text });
			await options.reply?.(chatId, text);
		},
		typing: { start: (chatId) => started.push(chatId) },
		...(options.inbox === undefined ? {} : { inbox: options.inbox }),
	});
	return { state, poller, api, door, chats, lines, said, started, directory };
}

/**
 * A promise that must settle within `ms`. A poller that waits for a queued answer would otherwise hang the suite rather
 * than fail it, and a hang says nothing about which line did it.
 */
async function within<T>(what: string, work: Promise<T>, ms = 2_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
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
		readonly inbox?: StubInbox;
	} = {},
): Promise<DownRig> {
	const directory = await mkdtemp(join(tmpdir(), "mason-telegram-"));
	directories.add(directory);
	const state = new StateFiles(directory);
	await state.writeOffset(options.offset ?? 100);
	const waits: number[] = [];
	const lines: string[] = [];
	const door = new RecordingDoor(script.at(-1) ?? ACCEPTED, script);
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
		...(options.inbox === undefined ? {} : { inbox: options.inbox }),
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
				ACCEPTED,
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
				ACCEPTED,
				{ kind: "unreachable", error: "the door answered 429 with a 3600s wait" },
				ACCEPTED,
				ACCEPTED,
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
				ACCEPTED,
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

describe("a message with a file", () => {
	const FILE: EventFile = {
		path: "/home/mason/.mason/agent/workspace/inbox/100-report.pdf",
		name: "100-report.pdf",
		size: 4_096,
		kind: "document",
	};

	it("fires the sentence that says a file arrived and where it landed", async () => {
		const inbox = new StubInbox({ kind: "saved", file: FILE });
		const { poller, door } = await rig([[documentUpdate(100)]], { offset: 100, inbox });

		await poller.pollOnce();

		assert.equal(
			door.envelopes[0]?.payload,
			`Ilya (@ilya) in chat -1001234 (Team chat): sent a file: report.pdf, with a file at ${FILE.path}`,
		);
		assert.deepEqual(
			inbox.saved.map((saved) => [saved.attachment.name, saved.updateId]),
			[["report.pdf", 100]],
		);
	});

	it("fires it without a path when the fetch was refused, and says why in one line", async () => {
		const inbox = new StubInbox({ kind: "refused", reason: "it is 21 MiB, and a bot may download 20 MiB" });
		const { poller, door, lines } = await rig([[documentUpdate(100)]], { offset: 100, inbox });

		await poller.pollOnce();

		assert.equal(
			door.envelopes[0]?.payload,
			"Ilya (@ilya) in chat -1001234 (Team chat): sent a file: report.pdf",
			"the text still says a file was meant, and nothing names a path that is not there",
		);
		const warnings = lines.filter((line) => line.includes("could not fetch the document in update 100"));
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /21 MiB/);
	});

	it("fires it without a path when saving threw, because a message is not lost to a bug in the file path", async () => {
		const inbox = new StubInbox(new Error("EACCES: permission denied"));
		const { poller, door, lines } = await rig([[documentUpdate(100)]], { offset: 100, inbox });

		await poller.pollOnce();

		assert.equal(door.envelopes.length, 1);
		assert.equal(door.envelopes[0]?.payload, "Ilya (@ilya) in chat -1001234 (Team chat): sent a file: report.pdf");
		assert.match(lines.join("\n"), /EACCES: permission denied\); delivering the message without it/);
	});

	it("fetches the file once, even when the door holds the batch and the envelope is posted again", async () => {
		const inbox = new StubInbox({ kind: "saved", file: FILE });
		const down = await pollAgainstDoor(
			[
				{ kind: "unreachable", error: "connect ECONNREFUSED" },
				{ kind: "unreachable", error: "connect ECONNREFUSED" },
				ACCEPTED,
			],
			{ batches: [[documentUpdate(100)]], offset: 100, inbox },
		);

		assert.equal(down.door.envelopes.length, 3, "the same message, three attempts");
		assert.equal(inbox.saved.length, 1, "a 20 MiB download is not repeated for every retry");
	});
});

describe("a command in the chat", () => {
	it("posts a slash message as a command, posts the answer, and fires no turn", async () => {
		// A group sends `/stop@mason_bot`, and the mention stripper has already left `/stop` by the time the filter answers.
		const { poller, door, state, directory, said, started } = await rig([[update(100, { text: "/stop@mason_bot" })]], {
			offset: 100,
			door: handled("stopped"),
		});

		await poller.pollOnce();

		assert.deepEqual(door.envelopes, [{ v: 1, id: "tg-100", kind: "command", payload: "stop" }]);
		assert.deepEqual(said, [{ chatId: "-1001234", text: "stopped" }], "the chat reads the one line mason answered");
		assert.deepEqual(started, [], "a command is not a turn, so nothing is typing");
		assert.deepEqual(await readOffset(state, directory), { offset: 101 });
	});

	it("sends the message it kept when mason says it did not handle the word", async () => {
		const { poller, door, state, directory, said, started } = await rig([[update(100, { text: "/stopp" })]], {
			offset: 100,
			door: ACCEPTED,
		});

		await poller.pollOnce();

		assert.deepEqual(
			door.envelopes.map((envelope) => [envelope.kind, envelope.payload]),
			[
				["command", "stopp"],
				["chat.message", "Ilya (@ilya) in chat -1001234 (Team chat): /stopp"],
			],
			"the same update, delivered as the message it always was",
		);
		assert.deepEqual(said, []);
		assert.deepEqual(started, ["-1001234"], "the message is the thing a turn is started for");
		assert.deepEqual(await readOffset(state, directory), { offset: 101 });
	});

	it("does not wait for an answer that is still queued, so one chat cannot hold the batch", async () => {
		// The send queue waits out a chat's twenty-a-minute window, which can be a minute, and this is one loop for every
		// chat: an answer parked there would put a `/stop` typed in another chat behind a spent window it has nothing to do
		// with. Both answers are handed over, and neither is waited for.
		let release!: () => void;
		const queued = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { poller, door, state, directory, said } = await rig(
			[[update(100, { text: "/help" }), update(101, { text: "/stop" }), update(102, { text: "ship it?" })]],
			{ offset: 100, door: handled("stopped"), reply: () => queued },
		);

		await within("a batch whose answers are still queueing", poller.pollOnce());

		assert.deepEqual(
			door.envelopes.map((envelope) => envelope.kind),
			["command", "chat.message"],
			"the command and the message behind it went out while both answers were still waiting for their window",
		);
		assert.deepEqual(await readOffset(state, directory), { offset: 103 });
		assert.deepEqual(
			said.map((line) => line.text),
			[HELP_TEXT, "stopped"],
			"both were handed to the queue; the batch did not wait for either",
		);
		release();
	});

	it("falls back to the message when the door refuses the command, and posts the rule it broke", async () => {
		const reason = '"stop" takes no argument: a command is one word, and only "compact" reads what follows it';
		const { poller, door, state, directory, said, started } = await rig([[update(100, { text: "/stop now" })]], {
			offset: 100,
			script: [{ kind: "refused", status: 400, reason }, ACCEPTED],
		});

		await poller.pollOnce();

		// A refused command is not a refused message: the offset still advances, and the person's words still arrive — but
		// the door's own sentence about the rule goes into the chat first, because a silent chat was the worst answer of the
		// three the design had.
		assert.deepEqual(
			door.envelopes.map((envelope) => [envelope.kind, envelope.payload]),
			[
				["command", "stop now"],
				["chat.message", "Ilya (@ilya) in chat -1001234 (Team chat): /stop now"],
			],
		);
		assert.deepEqual(said, [
			{
				chatId: "-1001234",
				text: `mason could not run that command: ${reason}; it is being delivered as a message`,
			},
		]);
		assert.deepEqual(started, ["-1001234"], "the message is the thing a turn is started for");
		assert.deepEqual(await readOffset(state, directory), { offset: 101 });
	});

	it("answers /help itself, without posting anything to mason", async () => {
		const { poller, door, state, directory, said } = await rig([[update(100, { text: "/help" })]], { offset: 100 });

		await poller.pollOnce();

		assert.deepEqual(door.envelopes, [], "the relay describing itself is not a request");
		assert.deepEqual(said, [{ chatId: "-1001234", text: HELP_TEXT }]);
		assert.deepEqual(await readOffset(state, directory), { offset: 101 });
	});

	it("is posted in the same batch as the message before it, so /stop does not wait for the turn it stops", async () => {
		const { poller, door, said } = await rig(
			[[update(100, { text: "write the report" }), update(101, { text: "/stop" })]],
			{ offset: 100, door: handled("stopped") },
		);

		await poller.pollOnce();

		// The poller's only wait is the door's answer, and a running turn is not one: both updates go out in order and the
		// command is the second envelope before the first turn has reported anything.
		assert.deepEqual(
			door.envelopes.map((envelope) => envelope.kind),
			["chat.message", "command"],
		);
		assert.deepEqual(said, [{ chatId: "-1001234", text: "stopped" }]);
	});

	it("does not fetch the file a command's caption carried", async () => {
		// A caption that is a command is not a message about a file, and a 20 MiB download spent on `/stop` is spent for
		// nothing. The words are the whole envelope.
		const inbox = new StubInbox({ kind: "saved", file: { path: "/inbox/100-report.pdf", name: "100-report.pdf", size: 1, kind: "document" } });
		const { poller, door, said } = await rig(
			[
				[
					update(100, {
						text: undefined,
						caption: "/compact keep the pricing thread",
						document: { file_id: "f1", file_unique_id: "u1", file_name: "report.pdf" },
					}),
				],
			],
			{ offset: 100, door: handled("compacted"), inbox },
		);

		await poller.pollOnce();

		assert.deepEqual(door.envelopes, [
			{ v: 1, id: "tg-100", kind: "command", payload: "compact keep the pricing thread" },
		]);
		assert.equal(inbox.saved.length, 0, "no download for a command");
		assert.deepEqual(said, [{ chatId: "-1001234", text: "compacted" }]);
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
