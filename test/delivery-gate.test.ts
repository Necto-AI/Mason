/**
 * The reader never gets silence for an answer.
 *
 * `send` is a tool, so calling it is the model's choice and the prompt is only advice. These tests pin the
 * guarantee behind the advice: a turn that ends with nothing delivered continues once with a reminder, and a second
 * silent answer shows the reader a notice instead of nothing. The reminder itself is never part of the transcript.
 *
 * Two of these tests drive a delivery from inside another tool, the way a code-mode script does: the attempt is
 * refused, the turn is reminded as if it had never spoken, and the model's own call is the only thing the reader sees.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	defineExtension,
	defineTool,
	type EntryRecord,
	type Extension,
	type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { projectTranscript } from "../src/server/projection.ts";
import { isInputEntry, turnOriginOf } from "../src/server/replies.ts";
import { type AgentRuntime, openAgentRuntime, type ResolvedModel } from "../src/server/runtime.ts";
import {
	DELIVERY_REMINDER,
	isDeliveryReminder,
	isReflectionAsk,
	REFLECTION_ASK,
	SEND_TOOL,
} from "../src/shared/contract.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/**
 * A runTurn home carries one routine, because a boot ships none and a fired turn needs a hook to answer. The interval
 * is far past every test's lifetime, so only the test's own fire becomes a turn.
 */
async function seedRoutine(directory: string): Promise<void> {
	await mkdir(join(directory, "house", "agent"), { recursive: true, mode: 0o700 });
	await writeFile(
		join(directory, "house", "agent", "events.json"),
		JSON.stringify([
			{
				source: "telegram",
				kind: "chat.message",
				enabled: true,
				prompt: "A message arrived in the chat: the person you work for asked. Answer it with send.\n{{payload}}",
			},
			{
				source: "routine",
				name: "team-chat",
				enabled: true,
				prompt: "A message arrived in the chat: the person you work for asked. Answer it with send.\n{{payload}}",
				schedule: { every: 1, unit: "week", at: "09:00", timezone: "UTC", days: ["mon"] },
			},
		]),
	);
}

function fauxAccess(): { access: ResolvedModel; faux: ReturnType<typeof fauxProvider> } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true }, faux };
}

/** Nothing delivered: the answer the model wrote is working notes. */
function said(text: string): FauxResponseStep {
	return fauxAssistantMessage(fauxText(text));
}

/** A message the reader sees. */
function deliver(message: string, id = "sent"): FauxResponseStep {
	return fauxAssistantMessage([fauxToolCall(SEND_TOOL, { text: message }, { id })], { stopReason: "toolUse" });
}

function call(name: string, arguments_: JsonObject, id: string): FauxResponseStep {
	return fauxAssistantMessage([fauxToolCall(name, arguments_, { id })], { stopReason: "toolUse" });
}

/** A scripted provider that also records what each request was asked with. */
function recorder(steps: readonly FauxResponseStep[]): {
	steps: FauxResponseStep[];
	requests: Message[][];
} {
	const requests: Message[][] = [];
	const queue: FauxResponseStep[] = steps.map((step) => {
		return (context) => {
			requests.push([...context.messages] as Message[]);
			return typeof step === "function"
				? step(
						context,
						undefined,
						{ callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] },
						undefined as never,
					)
				: step;
		};
	});
	return { steps: queue, requests };
}

/**
 * A turn, scripted: how it started, and everything it left behind.
 *
 * The evidence is deliberately more than the reader's transcript: a refusal or a "delivered" is a tool result, and the
 * transcript is the one place it does not appear, so the raw entries come back too.
 */
async function runTurn(
	directory: string,
	script: ReturnType<typeof recorder>,
	extensions: readonly Extension[],
	start: (runtime: AgentRuntime) => Promise<{
		wait(context: typeof BACKGROUND_CONTEXT): Promise<SettledSubmissionRecord>;
	}>,
) {
	const { access, faux } = fauxAccess();
	faux.setResponses(script.steps);
	const runtime: AgentRuntime = await openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		houseHome: join(directory, "house"),
		storage: "memory",
		modelAccess: access,
		// Extra tools, for the tests that need a tool which delivers from inside its own execution.
		extensions,
		onReport: () => {},
	});
	try {
		const settled = await (await start(runtime)).wait(BACKGROUND_CONTEXT);
		const state = await runtime.viewSnapshot(BACKGROUND_CONTEXT);
		return {
			settled,
			transcript: projectTranscript(state),
			entries: (state?.entries ?? []) as readonly EntryRecord[],
			requests: script.requests,
		};
	} finally {
		await runtime.close();
	}
}

/** A turn nothing outside mason started: the only case where the transcript is the reader. */
function runScripted(
	directory: string,
	script: ReturnType<typeof recorder>,
	prompt = "Anything new?",
	extensions: readonly Extension[] = [],
) {
	return runTurn(directory, script, extensions, async (runtime) => {
		const conversation = await runtime.conversation();
		return conversation.submit({ type: "input", content: prompt }, BACKGROUND_CONTEXT);
	});
}

/** One fire, one turn: the id is the sender's, so it has to be one only this test uses. */
let fires = 0;

/**
 * A turn an event hook started, through a fired hook the home's routine file names: the chat door firing `team-chat`,
 * which is how the person in the chat reaches the agent.
 */
function runFired(
	directory: string,
	script: ReturnType<typeof recorder>,
	extensions: readonly Extension[] = [],
	payload = "Привет",
) {
	return runTurn(directory, script, extensions, async (runtime) => {
		fires += 1;
		return runtime.hooks.fire("team-chat", { payload, requestId: `delivery-gate:${fires}` });
	});
}

/** What a call answered: the text the model read, and whether it was refused (which code mode turns into a rejection). */
function answerTo(entries: readonly EntryRecord[], callId: string): { isError: boolean; text: string } {
	for (const entry of entries) {
		if (entry.kind !== "pi.tool-result") continue;
		const message = entry.model?.[0] as { toolCallId?: unknown; isError?: unknown; content?: unknown } | undefined;
		if (message?.toolCallId !== callId) continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((part) => {
								const block = part as { type?: unknown; text?: unknown };
								return block.type === "text" && typeof block.text === "string" ? block.text : "";
							})
							.join("")
					: "";
		return { isError: message.isError === true, text };
	}
	return { isError: false, text: "" };
}

/** Whether the gate ever nudged the model: a reminder is only ever a user input the gate added, in either shape. */
function reminded(requests: readonly (readonly Message[])[]): boolean {
	return requests.some((messages) =>
		messages.some((message) => typeof message.content === "string" && isDeliveryReminder(message.content)),
	);
}

/** What a nested call answered the script: whether it failed, and the text a program reads out of it. */
type NestedAnswer = { isError: boolean; text: string };

/**
 * A tool that delivers inside its own execution, the way a code-mode script does: what the script calls becomes a
 * nested `pi.tool` task, whose result goes back to the caller instead of into the transcript. The answers are handed
 * back so a test can read what the model would have been told.
 */
function scriptedDelivery(answers: NestedAnswer[]): Extension {
	const tool = defineTool({
		name: "deliverFromScript",
		description: "Send a message from inside a script.",
		parameters: Type.Object({
			message: Type.Optional(Type.String()),
		}),
		execute: async ({ message }, api, context) => {
			const nested = await api.executeTool(SEND_TOOL, { text: message ?? "" }, context);
			answers.push({
				isError: nested.isError,
				// A nested result carries the tool's value for programs, never the output written for the model: an error
				// the harness wrote itself has no value at all, and the diagnostics are what says why.
				text:
					typeof nested.structuredOutput === "string"
						? nested.structuredOutput
						: nested.diagnostics.map((diagnostic) => diagnostic.message ?? "").join("\n"),
			});
			return { output: [{ type: "text", text: "script ran" }], details: {} };
		},
	});
	return defineExtension({ name: "scripted-delivery", tools: [tool] });
}

/**
 * The two tools a long turn needs here: a probe, because a round of work is what the counter counts, and a write, so the
 * extraction leaves the file a test can read back. The workspace is a real machine in production; the point here is the
 * ask and the file it leaves behind.
 */
function keeper(kept: string[]): Extension {
	const keep = defineTool({
		name: "keep",
		description: "Write one line to one of the agent's own files.",
		parameters: Type.Object({ path: Type.String(), line: Type.String() }),
		execute: async ({ path, line }) => {
			kept.push(`${path}: ${line}`);
			return { output: [{ type: "text", text: `kept in ${path}` }], details: {} };
		},
	});
	const check = defineTool({
		name: "check",
		description: "Read one thing back.",
		parameters: Type.Object({ what: Type.String() }),
		execute: async ({ what }) => ({ output: [{ type: "text", text: `${what}: fine` }], details: {} }),
	});
	return defineExtension({ name: "keeper", tools: [keep, check] });
}

/**
 * A turn that writes one of mason's own working notes before it answers: a compaction's summary, or the prompt a turn
 * was planned with. Both carry a `user`-role message, which is what made the newest-input read take one for the person's
 * own words (#199). A tool writes it because a test cannot reach into a running turn any other way, and `EntryDraft`
 * carries the messages, so the entry is the one a real compaction commits.
 */
function workingNote(kind: "pi.compaction" | "pi.system", text: string): Extension {
	const tool = defineTool({
		name: "writeWorkingNote",
		description: "Write mason's own working note into the transcript, the way a compaction does.",
		parameters: Type.Object({}),
		execute: async (_arguments, api, context) => {
			await api.commit(
				(tx) =>
					tx.appendEntry(api.conversationId, { kind, model: [{ role: "user", content: text, timestamp: 0 }] }),
				context,
			);
			return { output: [{ type: "text", text: `${kind} written` }], details: {} };
		},
	});
	return defineExtension({ name: "working-note", tools: [tool] });
}

/** One round of work that changes nothing: the count is the point, not the output. */
function probed(id: string, what: string): FauxResponseStep {
	return call("check", { what }, id);
}

/** The one round that keeps something, in the file the ask names. */
function worked(id: string, fact: string): FauxResponseStep {
	return call("keep", { path: "agent/log/2026-11-05.md", line: fact }, id);
}

/** The requests the gate's ask started: it is the newest message of the request it opens, and of no other. */
function askRequests(requests: readonly (readonly Message[])[]): (readonly Message[])[] {
	return requests.filter((messages) => {
		const newest = messages.at(-1) as { content?: unknown } | undefined;
		return typeof newest?.content === "string" && isReflectionAsk(newest.content);
	});
}

function temporary(): Promise<string> {
	return mkdtemp(join(tmpdir(), "mason-delivery-gate-")).then((directory) => {
		directories.add(directory);
		return directory;
	});
}

test("a turn that answers in prose is reminded, and the reminder never reaches the reader", async () => {
	const directory = await temporary();
	const script = recorder([said("The standup moved to nine."), deliver("Standup moved to nine."), said("Done.")]);
	const { settled, transcript, requests } = await runScripted(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 3, "one reminder, one follow-up answer, no more");
	const reminded = requests[1]?.at(-1) as { role?: string; content?: unknown } | undefined;
	assert.equal(reminded?.role, "user");
	assert.equal(reminded?.content, DELIVERY_REMINDER, "the reminder is the turn's last input");
	assert.deepEqual(
		transcript.filter((item) => item.kind === "delivered").map((item) => (item as { text: string }).text),
		["Standup moved to nine."],
		"the reader sees the answer, once",
	);
	assert.ok(
		transcript.every((item) => (item as { text?: string }).text !== DELIVERY_REMINDER),
		"the reminder is not something the reader wrote, or reads",
	);
});

test("a turn that delivers is not reminded", async () => {
	const directory = await temporary();
	const script = recorder([deliver("Standup moved to nine."), said("Done.")]);
	const { settled, transcript, requests } = await runScripted(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 2, "the model's own turn, and nothing added to it");
	assert.ok(
		requests.every((messages) => !messages.some((message) => message.content === DELIVERY_REMINDER)),
		"no reminder was offered",
	);
	assert.equal(transcript.filter((item) => item.kind === "delivered").length, 1);
});

test("a delivery earlier in the turn counts, even across rounds", async () => {
	const directory = await temporary();
	// Two generations: the delivery's round, then a round that only remembers something, then the answer.
	const script = recorder([
		deliver("Standup moved to nine."),
		call("remember", { fact: "Denis moves standups to nine." }, "mem"),
		said("Done."),
	]);
	const { settled, transcript, requests } = await runScripted(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 3, "no reminder after a turn that already delivered");
	assert.equal(transcript.filter((item) => item.kind === "delivered").length, 1);
});

test("a turn that works and then stays silent is still a notice", async () => {
	const directory = await temporary();
	// A round of real work counts for nothing with the reader: the answer after it is what they were waiting for.
	const script = recorder([
		call("remember", { fact: "Denis moves standups to nine." }, "mem"),
		said("I will look into it."),
		said("Still looking into it."),
	]);
	const { settled, transcript, requests } = await runScripted(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 3, "one reminder after the silent answer to the work");
	assert.deepEqual(
		transcript.map((item) => item.kind),
		["user", "notice"],
		"the work the reader never saw does not count as an answer",
	);
});

test("a second silent answer is a notice, not another reminder", async () => {
	const directory = await temporary();
	const script = recorder([said("I will look into it."), said("Still looking into it.")]);
	const { settled, transcript, requests } = await runScripted(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 2, "one reminder per turn, never a loop");
	assert.deepEqual(
		transcript.map((item) => item.kind),
		["user", "notice"],
		"the reader's own message, and a notice where the answer would be",
	);
});

test("a message sent from inside a script is refused, and the gate still asks for one", async () => {
	const directory = await temporary();
	const answers: NestedAnswer[] = [];
	// The script tries to deliver and is told not to; the model then says it in prose, is reminded, and sends it itself.
	const script = recorder([
		call("deliverFromScript", { message: "Standup moved to nine." }, "run"),
		said("Standup moved to nine."),
		deliver("Standup moved to nine."),
		said("Done."),
	]);
	const { settled, transcript, requests } = await runScripted(directory, script, "Anything new?", [
		scriptedDelivery(answers),
	]);

	assert.equal(settled.status, "done");
	assert.equal(answers.length, 1, "the script made one nested call");
	assert.equal(answers[0]?.isError, true, "the nested delivery was refused, not delivered");
	assert.match(answers[0]?.text ?? "", /cannot deliver from inside a script/, "the refusal says what went wrong");
	assert.match(answers[0]?.text ?? "", /call send from the turn/, "and what to do instead");
	assert.equal(reminded(requests), true, "the refusal is not a delivery, so the turn is still silent to the gate");
	assert.equal(requests.length, 4, "the reminder added one round, and no more");
	assert.deepEqual(
		transcript.filter((item) => item.kind === "delivered").map((item) => (item as { text: string }).text),
		["Standup moved to nine."],
		"the reader sees the message once, from the model's own call",
	);
});

/**
 * The other reader: a turn an event hook started.
 *
 * A fire carries an origin when the sender could name a conversation, and the reply records it: the person is in a chat,
 * and the model never names the chat's own tool. A fire with no origin — a schedule, a retry — records the reply and
 * says nobody was reached. Either way the gate counts the same call, because there is one operation and not two.
 */
test("a hooked turn answers with send, and the gate counts the call", async () => {
	const directory = await temporary();
	const script = recorder([deliver("Привет!"), said("Done.")]);
	await seedRoutine(directory);
	const { settled, requests, entries, transcript } = await runFired(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 2, "the model's own turn, and nothing added to it");
	assert.equal(reminded(requests), false, "the reply is the delivery, in a hooked turn as anywhere else");
	assert.equal(answerTo(entries, "sent").isError, false, "the call was not refused");
	assert.match(answerTo(entries, "sent").text, /nobody was reached/, "a fire with no conversation says so");
	assert.deepEqual(
		transcript.filter((item) => item.kind === "delivered").map((item) => (item as { text: string }).text),
		["Привет!"],
		"the transcript still holds what the turn recorded",
	);
});

test("a fire that named its address records the origin, and the reply is the row", async () => {
	const directory = await temporary();
	const script = recorder([deliver("Привет!"), said("Done.")]);
	const telegram = {
		enabled: true,
		connector: {
			user: { owner: "8811" },
		},
	};
	const { setIntegrations } = await import("../src/server/integrations.ts");
	await seedRoutine(directory);
	const { settled, entries } = await runTurn(directory, script, [], async (runtime) => {
		// The operator's configuration, as the boot would have it: the reply can only name a connector that exists.
		setIntegrations({ telegram: telegram as never });
		fires += 1;
		return runtime.hooks.fire("team-chat", {
			payload: "Привет",
			requestId: `delivery-gate:routed:${fires}`,
			origin: { connector: "telegram", ref: "team", messageId: "m1" },
		});
	});
	try {
		assert.equal(settled.status, "done");
		const reply = entries.find((entry) => entry.kind === "app.reply");
		assert.deepEqual((reply?.data as { origin?: unknown }).origin, {
			connector: "telegram",
			ref: "team",
			messageId: "m1",
		});
		const hook = entries.find((entry) => entry.kind === "app.hook");
		assert.deepEqual((hook?.data as { origin?: unknown }).origin, {
			connector: "telegram",
			ref: "team",
			messageId: "m1",
		});
	} finally {
		setIntegrations({});
	}
});

test("a hooked turn that says nothing is reminded, and the reminder names send", async () => {
	const directory = await temporary();
	const script = recorder([said("I will look into it."), deliver("Привет!"), said("Done.")]);
	await seedRoutine(directory);
	const { settled, requests } = await runFired(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 3, "one reminder, one answer, no more");
	const reminder = requests[1]?.at(-1) as { role?: string; content?: unknown } | undefined;
	assert.equal(reminder?.role, "user");
	assert.equal(reminder?.content, DELIVERY_REMINDER, "the same reminder, because there is the same one tool");
	assert.match(String(reminder?.content), /`send`/);
});

test("a local turn still delivers with send while a chat-facing routine exists", async () => {
	const directory = await temporary();
	const script = recorder([deliver("Standup moved to nine."), said("Done.")]);
	const { settled, requests, entries, transcript } = await runScripted(directory, script, "Anything new?");

	assert.equal(settled.status, "done");
	assert.equal(answerTo(entries, "sent").isError, false, "the local turn's delivery is not refused");
	assert.equal(answerTo(entries, "sent").text, "delivered to the transcript");
	assert.equal(requests.length, 2, "no reminder: the transcript is this turn's reader");
	assert.deepEqual(
		transcript.filter((item) => item.kind === "delivered").map((item) => (item as { text: string }).text),
		["Standup moved to nine."],
	);
});

/**
 * The second gate on the same plumbing: a turn of real work ends by keeping what it learned.
 *
 * `beforeRequest` counts the turn's tool rounds and memoizes it, `onYield` continues the run once with the ask. The ask
 * is a `pi.user` entry like the reminder, so the projection drops it and the reader sees only the reply that says what
 * was kept. The guards are the ask's words: this is where the wording is pinned, because wording is what an instruction
 * has, and what code can enforce of it is the tool machine's mount of `agent/` alone (ADR 0013: no gateway, no approval).
 */
test("a turn of ten tool rounds is asked once what to keep, and the reader never sees the question", async () => {
	const directory = await temporary();
	const kept: string[] = [];
	const script = recorder([
		probed("r1", "the deploy order"),
		probed("r2", "the release notes"),
		probed("r3", "the two schemas"),
		probed("r4", "the rollback path"),
		probed("r5", "the migration plan"),
		probed("r6", "the plan on a copy"),
		probed("r7", "the slow step"),
		probed("r8", "the routine behind it"),
		probed("r9", "the fix"),
		deliver("The migration is done, and the release notes are updated."),
		said("Done."),
		// The continuation's own turn: the extraction, then the reply that reports it.
		worked("r11", "Denis moves standups to nine."),
		deliver("Kept one line about the standup."),
		said("Done."),
	]);
	const { settled, requests, transcript, entries } = await runScripted(
		directory,
		script,
		"Migrate the notes while I am out.",
		[keeper(kept)],
	);

	assert.equal(settled.status, "done");
	const asked = askRequests(requests);
	assert.equal(asked.length, 1, "the ask is offered once, at the end of the ten-round turn");
	const ask = asked[0]?.at(-1) as { role?: string; content?: unknown } | undefined;
	assert.equal(ask?.role, "user");
	assert.equal(ask?.content, REFLECTION_ASK, "the turn's last input is the ask");
	assert.ok(
		transcript.every((item) => (item as { text?: string }).text !== REFLECTION_ASK),
		"the question is the model's, not the reader's",
	);
	// The done-when: the turn ended with a change, and the change is a line in the agent's own file.
	assert.deepEqual(kept, ["agent/log/2026-11-05.md: Denis moves standups to nine."]);
	assert.deepEqual(
		transcript.filter((item) => item.kind === "delivered").map((item) => (item as { text: string }).text),
		["The migration is done, and the release notes are updated.", "Kept one line about the standup."],
	);
	assert.equal(answerTo(entries, "r11").isError, false, "the extraction ran in the turn that did the work");
});

test("a turn that fits in three tool rounds is never asked what to keep", async () => {
	const directory = await temporary();
	const kept: string[] = [];
	const script = recorder([
		probed("r1", "the file"),
		probed("r2", "the count"),
		probed("r3", "the count again"),
		deliver("Three items in notes.md."),
		said("Done."),
	]);
	const { settled, requests, transcript } = await runScripted(directory, script, "How many items are in notes.md?", [
		keeper(kept),
	]);

	assert.equal(settled.status, "done");
	assert.deepEqual(askRequests(requests), [], "short work is not a turn to look back on");
	assert.equal(requests.length, 5, "nothing was added to the model's own turn");
	assert.deepEqual(kept, [], "and nothing was written for the sake of writing");
	assert.equal(transcript.filter((item) => item.kind === "delivered").length, 1);
});

/**
 * The count and the reminder share a context: a long turn that ends in silence is reminded first, and the rounds that
 * earned the ask are still in the turn when it answers. A count that restarted at the continuation would ask nobody,
 * which is exactly the turn that needed it.
 */
test("a long turn that ends silently is reminded, answers, and is then asked what to keep", async () => {
	const directory = await temporary();
	const kept: string[] = [];
	const script = recorder([
		probed("r1", "the release notes"),
		probed("r2", "the schemas"),
		probed("r3", "the rollback path"),
		probed("r4", "the plan"),
		probed("r5", "the plan on a copy"),
		probed("r6", "the slow step"),
		probed("r7", "the routine"),
		probed("r8", "the fix"),
		probed("r9", "the plan again"),
		probed("r10", "the copy"),
		said("The migration is done."),
		// Reminded, the model says what it meant to say; then the ask arrives, and the extraction ends with a reply.
		deliver("The migration is done, and the release notes are updated."),
		said("Done."),
		deliver("Nothing worth keeping."),
		said("Done."),
	]);
	const { settled, requests } = await runScripted(directory, script, "Migrate the notes while I am out.", [
		keeper(kept),
	]);

	assert.equal(settled.status, "done");
	const reminded = requests.findIndex((messages) => messages.some((message) => message.content === DELIVERY_REMINDER));
	const asked = requests.findIndex((messages) =>
		messages.some((message) => typeof message.content === "string" && isReflectionAsk(message.content)),
	);
	assert.ok(reminded !== -1, "the turn ended once with nothing delivered, so it was reminded");
	assert.ok(asked > reminded, "the ask comes after the answer the reminder produced");
	assert.equal(askRequests(requests).length, 1, "and the turn is asked once, however many times it ends");
	assert.deepEqual(kept, [], "the extraction happened, and its honest answer was that there was nothing to write");
});

test("the reflection ask carries the guards, and says what to do when nothing was worth keeping", () => {
	assert.match(REFLECTION_ASK, /^\[reflection\] /, "a marker, so a person's own line cannot be mistaken for it");
	assert.match(REFLECTION_ASK, /read `agent\/profile\.md`/, "the file is read before it is rewritten");
	assert.match(
		REFLECTION_ASK,
		/one dated line to\s+`agent\/log\/YYYY-MM-DD\.md`/,
		"a fact with a date goes to the log",
	);
	assert.match(REFLECTION_ASK, /under 60 characters/, "a skill's description stays short enough for the index");
	assert.match(REFLECTION_ASK, /inside `agent\/`/, "writes stay on the agent's half of the home");
	assert.match(REFLECTION_ASK, /retire a\s+skill only by naming what absorbed it/, "a skill is not dropped quietly");
	assert.match(
		REFLECTION_ASK,
		/nothing was worth keeping/,
		"a turn that taught nothing says so, instead of inventing",
	);
	assert.equal(
		isReflectionAsk("[reflection] That was a big one, anything to keep?"),
		false,
		"a person's line is kept",
	);
});

test("a fire that named its conversation keeps its origin through the reflection ask", async () => {
	const directory = await temporary();
	const kept: string[] = [];
	const script = recorder([
		probed("r1", "the deploy order"),
		probed("r2", "the release notes"),
		probed("r3", "the two schemas"),
		probed("r4", "the rollback path"),
		probed("r5", "the migration plan"),
		probed("r6", "the plan on a copy"),
		probed("r7", "the slow step"),
		probed("r8", "the routine behind it"),
		probed("r9", "the fix"),
		deliver("The migration is done, and the release notes are updated."),
		said("Done."),
		// The continuation's own turn: the extraction, then the reply that reports it.
		worked("r10", "Denis moves standups to nine."),
		deliver("Kept one line about the standup."),
		said("Done."),
	]);
	const telegram = {
		enabled: true,
		connector: {
			user: { owner: "8811" },
		},
	};
	const { setIntegrations } = await import("../src/server/integrations.ts");
	await seedRoutine(directory);
	const { settled, entries } = await runTurn(directory, script, [keeper(kept)], async (runtime) => {
		setIntegrations({ telegram: telegram as never });
		fires += 1;
		return runtime.hooks.fire("team-chat", {
			payload: "Migrate the notes.",
			requestId: `delivery-gate:ask-target:${fires}`,
			origin: { connector: "telegram", ref: "team", messageId: "m9" },
		});
	});
	try {
		assert.equal(settled.status, "done");
		assert.equal(askRequests(script.requests).length, 1, "the ask landed, so this test sees the real misread");
		const replies = entries.filter((entry) => entry.kind === "app.reply");
		assert.ok(replies.length >= 1, "the turn spoke once");
		// The newest input after the ask is the ask itself, the misread; the reply must still carry its origin.
		for (const reply of replies) {
			assert.deepEqual((reply.data as { origin?: unknown }).origin, {
				connector: "telegram",
				ref: "team",
				messageId: "m9",
			});
		}
	} finally {
		setIntegrations({});
	}
});

/**
 * #199's deterministic repro, in two halves of the same rule: a working note written after the person's words and before
 * the answer.
 *
 * The newest input is what a turn's origin is read from, and both of these entries carry a `user`-role message, so a read
 * that finds the newest input by its text takes the summary for the person and the send commits unaddressed — the answer
 * is lost with nothing recording it as failed. The predicate refuses the kind instead, and the reply comes back with the
 * origin of the submission it answers.
 *
 * From Step 2 the same turn has a second, client-visible half: the state a client applies carries one reply row for it,
 * under one id. That is the assertion that outlives the delivery removal — the recorded origin says where the answer
 * went, and the row says the reader got it.
 */
for (const note of [
	{ kind: "pi.compaction", text: "Summary so far: the person asked about the migration." },
	{ kind: "pi.system", text: "The plan this turn was given: migrate the notes." },
] as const) {
	test(`a ${note.kind} entry written before the send keeps the turn's origin`, async () => {
		const directory = await temporary();
		const script = recorder([call("writeWorkingNote", {}, "note"), deliver("The migration is done."), said("Done.")]);
		const telegram = { enabled: true, connector: { user: { owner: "8811" } } };
		const { setIntegrations } = await import("../src/server/integrations.ts");
		await seedRoutine(directory);
		const { settled, entries, transcript } = await runTurn(
			directory,
			script,
			[workingNote(note.kind, note.text)],
			async (runtime) => {
				setIntegrations({ telegram: telegram as never });
				fires += 1;
				return runtime.hooks.fire("team-chat", {
					payload: "Migrate the notes.",
					requestId: `delivery-gate:working-note:${fires}`,
					origin: { connector: "telegram", ref: "team", messageId: "m7" },
				});
			},
		);
		try {
			assert.equal(settled.status, "done");
			assert.ok(
				entries.some((entry) => entry.kind === note.kind),
				"the working note is in the transcript the send reads",
			);
			const reply = entries.find((entry) => entry.kind === "app.reply");
			assert.deepEqual(
				(reply?.data as { origin?: unknown }).origin,
				{ connector: "telegram", ref: "team", messageId: "m7" },
				"the answer records the origin of the turn's input, not of the working note written after it",
			);
			// One message, one row: the id is the one the streaming row carried, so a client that watched the answer
			// arrive does not get a second row when it commits.
			const delivered = transcript.filter((row) => row.kind === "delivered");
			assert.equal(delivered.length, 1, "the reader's state carries exactly one reply row for the turn");
			assert.deepEqual(delivered[0], { kind: "delivered", id: "reply:sent", text: "The migration is done." });
		} finally {
			setIntegrations({});
		}
	});
}

test("nine tool rounds is under the ask, in the same turn shape that asks at ten", async () => {
	const directory = await temporary();
	const script = recorder([
		probed("r1", "the deploy order"),
		probed("r2", "the release notes"),
		probed("r3", "the two schemas"),
		probed("r4", "the rollback path"),
		probed("r5", "the migration plan"),
		probed("r6", "the plan on a copy"),
		probed("r7", "the slow step"),
		probed("r8", "the routine behind it"),
		deliver("Eight finds, one answer."),
		said("Done."),
	]);
	const { requests } = await runScripted(directory, script, "Migrate the notes while I am out.");
	assert.equal(askRequests(requests).length, 0, "nine carried calls is one short of the gate");
});

test("a second long turn is asked once more than its first", async () => {
	const directory = await temporary();
	const kept: string[] = [];
	const probes = (tag: string) => [
		probed(`${tag}1`, "the deploy order"),
		probed(`${tag}2`, "the release notes"),
		probed(`${tag}3`, "the two schemas"),
		probed(`${tag}4`, "the rollback path"),
		probed(`${tag}5`, "the migration plan"),
		probed(`${tag}6`, "the plan on a copy"),
		probed(`${tag}7`, "the slow step"),
		probed(`${tag}8`, "the routine behind it"),
		probed(`${tag}9`, "the fix"),
	];
	const script = recorder([
		...probes("a"),
		deliver("The first migration is done."),
		said("Done."),
		// The first ask's continuation, then a new turn the person starts once it landed, with its own ten carried calls.
		deliver("Kept one line about the first run."),
		said("Done."),
		...probes("b"),
		deliver("The second migration is done."),
		said("Done."),
		// The second ask's continuation ends the conversation on a settle.
		deliver("Kept one line about the second run."),
		said("Done."),
	]);
	// Two separate submits: a single submit's continuation is the same turn and gets no second ask.
	const { settled, requests } = await runTurn(directory, script, [keeper(kept)], async (runtime) => {
		const conversation = await runtime.conversation();
		await (await conversation.submit({ type: "input", content: "Migrate the first run." }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		const second = await (
			await conversation.submit({ type: "input", content: "Migrate the second run." }, BACKGROUND_CONTEXT)
		).wait(BACKGROUND_CONTEXT);
		return { wait: () => Promise.resolve(second) };
	});
	assert.equal(settled.status, "done");
	assert.equal(askRequests(requests).length, 2, "one ask per long turn; the second turn is still asked");
});

test("a connector entry is the sender's words, even when they quote a gate's opening line", () => {
	// A person can type anything on the wire, including the first words a gate prints. The routing read treats what a
	// connector carried as the sender's own words always, and the gates' tell applies to entries mason itself wrote.
	const askViaConnector = {
		id: 1,
		kind: "app.connector" as const,
		data: { origin: { connector: "telegram", ref: "team" } } as Record<string, unknown>,
		model: [{ role: "user" as const, content: REFLECTION_ASK }],
	} as unknown as EntryRecord;
	assert.equal(isInputEntry(askViaConnector), true, "their own quoting stays an input");
	assert.deepEqual(turnOriginOf([askViaConnector]), {
		kind: "connector",
		origin: { connector: "telegram", ref: "team" },
	});
});
