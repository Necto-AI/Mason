/**
 * Routines are data: one markdown file per routine, read at boot through the execution environment that the agent's own
 * volume is on.
 *
 * The two halves pinned here are the file format — what a routine may say, and what is refused with a reason a person
 * can act on — and the rule that makes a routine armed by its file rather than by the state the server wrote down
 * beside it. A routine's timer is `schedule.test.ts`'s and `hooks.test.ts`'s; this is what decides there is one.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Connection, LocalExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import { daemonCommand } from "../src/server/env.ts";
import { deliveryToolOf, HooksManager } from "../src/server/hooks.ts";
import { housePaths } from "../src/server/house.ts";
import { chatRoutineReports, loadRoutines, parseRoutine } from "../src/server/routines.ts";
import { openAgentRuntime } from "../src/server/runtime.ts";

const directories = new Set<string>();

/** The tool machine: the environment `agent/` is read through, which is the whole reason the loader takes one. */
const connection = new Connection({ command: daemonCommand(localDaemon()) });
const toolMachine = new LocalExecutionEnv({ connection, cwd: tmpdir() });

after(async () => {
	connection.close();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

/** A routine file, every field of it, so a test can remove the one it is about. */
function routineFile(overrides: Record<string, string | undefined> = {}, body = "Send the brief."): string {
	const fields: Record<string, string> = {
		name: "morning-brief",
		// Quoted, because the description has a colon in it: a routine's frontmatter is YAML, and a person's sentence is not.
		description: '"The start of the day: what is fixed, what is open, and the one thing to do first."',
		at: '"08:00"',
		tz: "Europe/Moscow",
		...overrides,
	};
	const frontmatter = Object.entries(fields)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
	return `---\n${frontmatter}\n---\n\n${body}\n`;
}

/** The error a file is refused with, or a failed assertion: a test that expects a refusal reads the reason. */
function refusal(text: string, filePath = "/home/mason/.mason/agent/routines/test.md"): string {
	const parsed = parseRoutine(text, filePath);
	assert.ok("error" in parsed, "the file is refused");
	return parsed.error;
}

describe("parseRoutine()", () => {
	it("reads a file into a hook definition, and names it after the file", () => {
		const parsed = parseRoutine(routineFile({ days: "1,2,3,4,5" }), "/home/mason/.mason/agent/routines/morning-brief.md");
		assert.ok("definition" in parsed);
		const { definition } = parsed;
		assert.equal(definition.id, "routine-morning-brief", "the id is the name, and cannot collide by accident");
		assert.equal(definition.name, "morning-brief");
		assert.equal(definition.description, "The start of the day: what is fixed, what is open, and the one thing to do first.");
		assert.equal(definition.enabled, false, "a routine is dark until the file says otherwise");
		assert.equal(definition.source, "file", "the file is the whole truth about the switch");
		assert.deepEqual(definition.schedule, {
			kind: "daily",
			at: "08:00",
			tz: "Europe/Moscow",
			days: [1, 2, 3, 4, 5],
		});
		assert.equal(definition.promptTemplate, "Send the brief.");
		assert.equal(deliveryToolOf(definition.promptTemplate), undefined, "a routine with no chat answers in the console");
	});

	it("arms it when the file says so, and reads days as the weekdays it names", () => {
		const parsed = parseRoutine(routineFile({ enabled: "true", days: "0,6" }), "/routines/weekend.md");
		assert.ok("definition" in parsed);
		assert.equal(parsed.definition.enabled, true);
		assert.deepEqual(parsed.definition.schedule?.days, [0, 6]);
	});

	it("appends the delivery sentence, in code, when the routine names a chat", () => {
		// Where the answer goes is the routine's own instruction, so the prose the person wrote cannot name a tool at all.
		const parsed = parseRoutine(routineFile({ chat: "-1001234567890" }), "/routines/morning-brief.md");
		assert.ok("definition" in parsed);
		assert.match(parsed.definition.promptTemplate, /^Send the brief\.\n\n/);
		assert.match(parsed.definition.promptTemplate, /Send the answer to chat -1001234567890 with mcp__telegram__send_message\.$/);
		assert.equal(deliveryToolOf(parsed.definition.promptTemplate), "mcp__telegram__send_message");
	});

	it("refuses a body that names a delivery tool, because where the answer goes is `chat`", () => {
		// The appended sentence is last, and the delivery is the first tool the instruction names: a body naming one would win
		// and the routine could answer somewhere the file never chose — or nowhere.
		assert.match(
			refusal(routineFile({ chat: "-1001234567890" }, "Send the brief with mcp__sneaky__send_message.")),
			/names mcp__sneaky__send_message.*put the chat id in `chat:`/,
		);
		assert.match(
			refusal(routineFile({}, "Answer in the chat with mcp__telegram__send_message.")),
			/names mcp__telegram__send_message/,
			"a file with no chat at all is refused too: the field, not the prose, says where an answer goes",
		);
	});

	it("refuses what a turn cannot be armed from, naming the file and the field", () => {
		assert.match(refusal(routineFile({ name: undefined })), /test\.md: no "name"/);
		assert.match(refusal(routineFile({ description: undefined })), /no "description"/);
		assert.match(refusal(routineFile({ at: undefined })), /no "at"/);
		assert.match(refusal(routineFile({ tz: undefined })), /no "tz"/);
		assert.match(refusal(routineFile({ name: "Morning Brief" })), /is not a routine name/);
		assert.match(refusal(routineFile({ name: "a".repeat(65) })), /is not a routine name/);
		assert.match(refusal(routineFile({ name: "with:colon" })), /is not a routine name/);
		assert.match(refusal(routineFile({ description: "x".repeat(201) })), /at most 200/);
		assert.match(refusal(routineFile({ at: '"8:00"' })), /schedule\.at/);
		assert.match(refusal(routineFile({ at: '"25:00"' })), /schedule\.at/);
		assert.match(refusal(routineFile({ tz: "Mars/Olympus" })), /no time zone/);
		assert.match(refusal(routineFile({ days: "1,9" })), /is not a weekday/);
		assert.match(refusal(routineFile({ days: "monday" })), /comma list of weekdays/);
		assert.match(refusal(routineFile({ days: "1,1" })), /twice/);
		assert.match(refusal(routineFile({ chat: "mason" })), /not a chat id/);
		assert.match(refusal(routineFile({ enabled: "yes" })), /"enabled" is true or false/);
		assert.match(refusal(routineFile({}, "   ")), /prompt after the frontmatter is empty/);
		assert.match(refusal(routineFile({}, "x".repeat(4_001))), /at most 4000/);
	});

	it("refuses a file with no frontmatter at all, rather than reading the whole file as a prompt", () => {
		const error = refusal("# Morning brief\n\nSend the brief.");
		assert.match(error, /no "name"/);
	});
});

describe("loadRoutines()", () => {
	it("reads every markdown file directly under the directory, sorted, and reports the rest", async () => {
		const dir = await tempDir("mason-routines-");
		await writeFile(join(dir, "weekly-review.md"), routineFile({ name: "weekly-review", at: '"18:00"' }), "utf8");
		await writeFile(join(dir, "daily.md"), routineFile({ name: "daily", enabled: "true" }), "utf8");
		await writeFile(join(dir, "broken.md"), "---\nname: broken\ndescription: Broken.\nat: '08:00'\n---\n\nno zone\n", "utf8");
		// Not a routine file: a directory of drafts, a note, and a document that is not markdown.
		await mkdir(join(dir, "drafts"));
		await writeFile(join(dir, "notes.txt"), "not a routine", "utf8");
		await writeFile(join(dir, "drafts", "nested.md"), routineFile({ name: "nested" }), "utf8");

		const loaded = await loadRoutines(toolMachine, dir, BACKGROUND_CONTEXT, []);
		assert.deepEqual(
			loaded.definitions.map((definition) => definition.id),
			["routine-daily", "routine-weekly-review"],
			"one level deep, sorted by file name",
		);
		assert.equal(loaded.definitions[0]?.enabled, true);
		assert.equal(loaded.reports.length, 1, "one line per file that is not a routine");
		assert.match(loaded.reports[0] ?? "", /broken\.md: no "tz"/);
	});

	it("refuses a routine whose id is already a hook's, instead of replacing it", async () => {
		const dir = await tempDir("mason-routines-taken-");
		await writeFile(join(dir, "team-chat.md"), routineFile({ name: "team-chat" }), "utf8");
		await writeFile(join(dir, "other.md"), routineFile({ name: "other" }), "utf8");

		const loaded = await loadRoutines(toolMachine, dir, BACKGROUND_CONTEXT, ["routine-team-chat"]);
		assert.deepEqual(loaded.definitions.map((definition) => definition.id), ["routine-other"]);
		assert.equal(loaded.reports.length, 1);
		assert.match(loaded.reports[0] ?? "", /routine-team-chat is already a builtin hook/);
	});

	it("refuses a file whose frontmatter name is not its own, because a routine is named by its file", async () => {
		const dir = await tempDir("mason-routines-stem-");
		await writeFile(join(dir, "morning-brief.md"), routineFile({ name: "daily" }), "utf8");

		const loaded = await loadRoutines(toolMachine, dir, BACKGROUND_CONTEXT, []);
		assert.deepEqual(loaded.definitions, [], "the file is two names for one routine, so it is neither");
		assert.equal(loaded.reports.length, 1);
		assert.match(loaded.reports[0] ?? "", /morning-brief\.md: the frontmatter names "daily"/);
		assert.match(loaded.reports[0] ?? "", /rename the file to daily\.md/);
	});

	it("reports a file it cannot read, and loads the ones beside it", async (t) => {
		if (process.getuid?.() === 0) {
			// The read is on the tool machine, as the same user: root is not refused by a mode bit, so there is no refusal to see.
			t.skip("a 000 file is readable as root");
			return;
		}
		const dir = await tempDir("mason-routines-unreadable-");
		await writeFile(join(dir, "good.md"), routineFile({ name: "good" }), "utf8");
		await writeFile(join(dir, "secret.md"), routineFile({ name: "secret" }), "utf8");
		await chmod(join(dir, "secret.md"), 0o000);

		const loaded = await loadRoutines(toolMachine, dir, BACKGROUND_CONTEXT, []);
		assert.deepEqual(loaded.definitions.map((definition) => definition.id), ["routine-good"]);
		assert.equal(loaded.reports.length, 1, "one line for the file, and the boot goes on");
		assert.match(loaded.reports[0] ?? "", /secret\.md: cannot be read: .*permission denied/i);
	});

	it("names an armed chat routine only while this boot did not connect its delivery tool", () => {
		const parsed = parseRoutine(
			routineFile({ chat: "-1001234567890", enabled: "true" }),
			"/routines/morning-brief.md",
		);
		assert.ok("definition" in parsed);
		const definitions = [parsed.definition];

		const nowhere = chatRoutineReports(definitions, []);
		assert.equal(nowhere.length, 1);
		assert.match(nowhere[0] ?? "", /routine-morning-brief answers in a chat/);
		assert.match(nowhere[0] ?? "", /this boot did not connect mcp__telegram__send_message/);
		// What the report asks is what the turn can find, and only that: an integration in the file is not a tool in the
		// list, and another integration's tools do not stand in for this one's.
		assert.equal(chatRoutineReports(definitions, ["mcp__github__create_issue"]).length, 1);
		assert.deepEqual(
			chatRoutineReports(definitions, ["mcp__telegram__send_message"]),
			[],
			"the boot connected the tool, so the fire has somewhere to answer",
		);
		// A draft has no fires, so a line about how its fires would end is a line about nothing.
		assert.deepEqual(
			chatRoutineReports([{ ...parsed.definition, enabled: false }], []),
			[],
			"disabled is a draft, and the boot does not warn about a routine that is not armed",
		);
		assert.deepEqual(
			chatRoutineReports([{ ...parsed.definition, promptTemplate: "Send the brief." }], []),
			[],
			"a routine with no chat answers in the console, and needs no integration",
		);
	});

	it("says nothing for a directory nobody has written a routine in", async () => {
		const missing = join(await tempDir("mason-routines-empty-"), "routines");
		assert.deepEqual(await loadRoutines(toolMachine, missing, BACKGROUND_CONTEXT, []), {
			definitions: [],
			reports: [],
		});
		const empty = await tempDir("mason-routines-empty-dir-");
		assert.deepEqual(await loadRoutines(toolMachine, empty, BACKGROUND_CONTEXT, []), {
			definitions: [],
			reports: [],
		});
	});
});

describe("a routine's switch", () => {
	/** A manager over a state file, and nothing to submit to: this is about `define()` and what it writes. */
	function managerOver(statePath: string): HooksManager {
		return new HooksManager({
			conversation: async () => {
				throw new Error("this manager never fires");
			},
			statePath,
		});
	}

	it("is the file's, whatever the persisted state remembered, while fire count and last fire are kept", async () => {
		const dir = await tempDir("mason-routines-state-");
		const statePath = join(dir, "hooks.json");
		// What a home armed by an older boot left: the switch the server wrote, and the runtime state beside it.
		await writeFile(
			statePath,
			JSON.stringify({ "routine-morning-brief": { enabled: true, fireCount: 7, lastFiredAt: "2026-10-19T05:00:00.000Z" } }),
			"utf8",
		);
		const parsed = parseRoutine(routineFile({ enabled: "false" }), join(dir, "morning-brief.md"));
		assert.ok("definition" in parsed);

		const hooks = managerOver(statePath);
		const hook = hooks.define(parsed.definition);
		assert.equal(hook.enabled, false, "a routine a person switched off is off, whoever turned it on before");
		assert.equal(hook.fireCount, 7, "how often it has fired is history, and history is kept");
		assert.equal(hook.lastFiredAt, "2026-10-19T05:00:00.000Z");

		// There is no second switch to flip: an arm taken here would fire once and revert on the next boot, so it is refused
		// and the refusal names the file that does own it.
		assert.throws(
			() => hooks.setEnabled("routine-morning-brief", true),
			/routine-morning-brief is a routine: it is armed by `enabled` in its file in agent\/routines\//,
		);
		assert.equal(hook.enabled, false, "the refused switch changed nothing");

		// And the server does not write a switch of its own back for it, where it does write one for a code hook: a second
		// copy would be a value that outlived the sentence it came from.
		hooks.define({ id: "manual", name: "Manual", description: "A hook defined in code.", enabled: false, promptTemplate: "go" });
		hooks.setEnabled("manual", true);
		const written = JSON.parse(await readFile(statePath, "utf8")) as Record<string, Record<string, unknown>>;
		assert.equal("enabled" in (written["routine-morning-brief"] ?? {}), false);
		assert.equal(written["routine-morning-brief"]?.fireCount, 7);
		assert.equal(written.manual?.enabled, true, "a code hook's switch is still written, which is what the state is for");
	});

	it("keeps a code hook's switch, which is what the persisted state is for", async () => {
		const dir = await tempDir("mason-routines-code-");
		const statePath = join(dir, "hooks.json");
		await writeFile(statePath, JSON.stringify({ manual: { enabled: true, fireCount: 2 } }), "utf8");
		const hooks = managerOver(statePath);
		const hook = hooks.define({
			id: "manual",
			name: "Manual",
			description: "A hook defined in code.",
			enabled: false,
			promptTemplate: "go",
		});
		assert.equal(hook.enabled, true, "a code hook's switch is the persisted one, as it always was");
		assert.equal(hook.fireCount, 2);
	});
});

/**
 * The wiring, at the one seam that would lose the whole feature silently: a boot that never calls the loader leaves the
 * bot with its builtins and no word about it.
 */
describe("a boot", () => {
	it("registers the routines the directory holds, and says which file it could not use", async () => {
		const home = await tempDir("mason-routines-boot-");
		const routinesDir = housePaths(home).routinesDir;
		await mkdir(routinesDir, { recursive: true });
		await writeFile(join(routinesDir, "daily.md"), routineFile({ name: "daily", enabled: "true" }), "utf8");
		// A routine whose answer is a chat, in a home with no integration to lend it the tool to answer with.
		await writeFile(
			join(routinesDir, "chatty.md"),
			routineFile({ name: "chatty", at: '"18:00"', chat: "-1001234567890", enabled: "true" }),
			"utf8",
		);
		// And the same routine unarmed: a draft with no fires is nobody's missing brief.
		await writeFile(
			join(routinesDir, "draft.md"),
			routineFile({ name: "draft", at: '"09:00"', chat: "-1001234567890" }),
			"utf8",
		);
		await writeFile(join(routinesDir, "broken.md"), "no frontmatter at all\n", "utf8");

		const reported: unknown[] = [];
		const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
			storage: "memory",
			houseHome: home,
			faux: true,
			onReport: (message) => reported.push(message),
		});
		try {
			const daily = runtime.hooks.get("routine-daily");
			assert.ok(daily, "the routine is a hook, and the file's `enabled` armed it");
			assert.equal(daily.enabled, true);
			assert.equal(daily.source, "file");
			assert.deepEqual(daily.schedule, { kind: "daily", at: "08:00", tz: "Europe/Moscow" });
			// The builtins are still theirs: a routine is one hook more, not a replacement for the list.
			assert.ok(runtime.hooks.has("team-chat"));
			assert.match(
				reported.map(String).find((message) => message.includes("broken.md")) ?? "",
				/broken\.md: no "name"/,
				"a file that is not a routine is said out loud, and the boot goes on without it",
			);
			assert.match(
				reported.map(String).find((message) => message.includes("routine-chatty")) ?? "",
				/this boot did not connect mcp__telegram__send_message/,
				"an armed chat routine with no tool to answer through would fire silently forever, so the boot says it",
			);
			assert.equal(
				reported.map(String).filter((message) => message.includes("routine-draft")).length,
				0,
				"a routine still at `enabled: false` has no fires to lose, so it is not reported",
			);
		} finally {
			await runtime.close();
		}
	});

	it("reports a chat routine when the integration that would lend its tool did not connect", async () => {
		// The file is not the boot: telegram is enabled with a tools face, and the face is at a url nothing answered. The
		// connect records it as unreachable and drops its tools, so the routine would fire into silence — and a check that
		// read `integrations.json` instead of the boot's tools said nothing at all.
		const home = await tempDir("mason-routines-unreachable-");
		const paths = housePaths(home);
		await mkdir(paths.routinesDir, { recursive: true });
		await writeFile(
			join(paths.routinesDir, "chatty.md"),
			routineFile({ name: "chatty", chat: "-1001234567890", enabled: "true" }),
			"utf8",
		);
		await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
		await writeFile(
			paths.integrations,
			JSON.stringify({
				integrations: {
					telegram: { enabled: true, description: "Telegram", tools: { url: "http://telegram:8080/mcp" } },
				},
			}),
			{ encoding: "utf8", mode: 0o600 },
		);

		const reported: unknown[] = [];
		const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
			storage: "memory",
			houseHome: home,
			faux: true,
			onReport: (message) => reported.push(message),
			mcpTransport: () => {
				throw new Error("connection refused");
			},
		});
		try {
			assert.ok(runtime.hooks.has("routine-chatty"), "the routine is a hook either way: its fire is not the door's");
			assert.match(
				reported.map(String).find((message) => message.includes("routine-chatty")) ?? "",
				/this boot did not connect mcp__telegram__send_message/,
				"what the turn can find is this boot's tools, not the entry in the file",
			);
		} finally {
			await runtime.close();
		}
	});

	it("boots with a trigger that fires a routine, because a routine is a hook by the time they are checked", async () => {
		// The check that would refuse this used to run before the routines were defined, so a trigger a person pointed at
		// `routine-<name>` refused the boot and named a hook that did exist.
		const home = await tempDir("mason-routines-trigger-");
		const paths = housePaths(home);
		await mkdir(paths.routinesDir, { recursive: true });
		await writeFile(join(paths.routinesDir, "daily.md"), routineFile({ name: "daily", enabled: "true" }), "utf8");
		await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
		await writeFile(
			paths.integrations,
			JSON.stringify({
				integrations: { telegram: { enabled: true, trigger: { hook: "routine-daily", secret: "0f".repeat(32) } } },
			}),
			{ encoding: "utf8", mode: 0o600 },
		);

		const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
			storage: "memory",
			houseHome: home,
			faux: true,
			onReport: () => {},
		});
		try {
			assert.ok(runtime.hooks.has("routine-daily"), "the trigger's hook is the routine, so the boot goes on");
		} finally {
			await runtime.close();
		}
	});

	it("keeps its builtin hooks, and says why, when the tool machine cannot be reached", async () => {
		// A boot that refuses over a routine is worse than a boot without one: the door, the transcript and the builtins
		// have to come up even when `agent/` is on a machine that will not answer.
		const home = await tempDir("mason-routines-env-");
		const routinesDir = housePaths(home).routinesDir;
		await mkdir(routinesDir, { recursive: true });
		await writeFile(join(routinesDir, "daily.md"), routineFile({ name: "daily", enabled: "true" }), "utf8");

		const reported: unknown[] = [];
		const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
			storage: "memory",
			houseHome: home,
			faux: true,
			onReport: (message) => reported.push(message),
			env: {
				envFor: async () => {
					throw new Error("connection lost");
				},
				close: async () => {},
			},
		});
		try {
			assert.ok(runtime.hooks.has("team-chat"), "the builtins survive a machine that cannot be read");
			assert.equal(runtime.hooks.has("routine-daily"), false, "and the routines are the part that is missing");
			const reasons = reported.map(String).filter((message) => message.startsWith("[routines] cannot read"));
			assert.equal(reasons.length, 1, "one line, not one per file");
			assert.match(reasons[0] ?? "", /builtin hooks only \(connection lost\)/);
		} finally {
			await runtime.close();
		}
	});
});
