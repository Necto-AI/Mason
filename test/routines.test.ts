/**
 * Routines are data: one markdown file per routine, read at boot through the execution environment that the agent's own
 * volume is on.
 *
 * The two halves pinned here are the file format — what a routine may say, and what is refused with a reason a person
 * can act on — and the rule that makes a routine armed by its file rather than by the state the server wrote down
 * beside it. A routine's timer is `schedule.test.ts`'s and `hooks.test.ts`'s; this is what decides there is one.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Connection, LocalExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import { daemonCommand } from "../src/server/env.ts";
import { deliveryToolOf, HooksManager } from "../src/server/hooks.ts";
import { housePaths } from "../src/server/house.ts";
import { loadRoutines, parseRoutine } from "../src/server/routines.ts";
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
		const parsed = parseRoutine(routineFile({ chat: "-1001234567890" }), "/routines/chatty.md");
		assert.ok("definition" in parsed);
		assert.match(parsed.definition.promptTemplate, /^Send the brief\.\n\n/);
		assert.match(parsed.definition.promptTemplate, /Send the answer to chat -1001234567890 with mcp__telegram__send_message\.$/);
		assert.equal(deliveryToolOf(parsed.definition.promptTemplate), "mcp__telegram__send_message");
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
		await writeFile(join(dir, "b-weekly.md"), routineFile({ name: "weekly-review", at: '"18:00"' }), "utf8");
		await writeFile(join(dir, "a-daily.md"), routineFile({ name: "daily", enabled: "true" }), "utf8");
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

	it("refuses the second of two files that claim one name, in file order", async () => {
		const dir = await tempDir("mason-routines-duplicate-");
		await writeFile(join(dir, "a.md"), routineFile({ name: "same" }), "utf8");
		await writeFile(join(dir, "b.md"), routineFile({ name: "same", enabled: "true" }), "utf8");

		const loaded = await loadRoutines(toolMachine, dir, BACKGROUND_CONTEXT, []);
		assert.equal(loaded.definitions.length, 1);
		assert.equal(loaded.definitions[0]?.enabled, false, "the first file is the one that won");
		assert.match(loaded.reports[0] ?? "", /is already the routine in .*a\.md/);
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

		// And the server does not write a switch of its own back for it: the file is the only place that line lives.
		hooks.setEnabled("routine-morning-brief", true);
		const written = JSON.parse(await readFile(statePath, "utf8")) as Record<string, Record<string, unknown>>;
		assert.equal("enabled" in (written["routine-morning-brief"] ?? {}), false);
		assert.equal(written["routine-morning-brief"]?.fireCount, 7);
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
		} finally {
			await runtime.close();
		}
	});
});
