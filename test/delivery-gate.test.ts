/**
 * The reader never gets silence for an answer.
 *
 * `reply` is a tool, so calling it is the model's choice and the prompt is only advice. These tests pin the
 * guarantee behind the advice: a turn that ends with nothing delivered continues once with a reminder, and a second
 * silent answer shows the reader a notice instead of nothing. The reminder itself is never part of the transcript.
 *
 * Two of these tests drive a delivery from inside another tool, the way a code-mode script does: the attempt is
 * refused, the turn is reminded as if it had never spoken, and the model's own call is the only thing the reader sees.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import { type AgentRuntime, openAgentRuntime, type ResolvedModel } from "../src/server/runtime.ts";
import { DELIVERY_REMINDER, isDeliveryReminder, REPLY_TOOL, WIDGET_TOOL } from "../src/shared/contract.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

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
	return fauxAssistantMessage([fauxToolCall(REPLY_TOOL, { message }, { id })], { stopReason: "toolUse" });
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

/** A turn a person started in the console: the only case where `reply` is the reader. */
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
 * A turn an event hook started, through the hook a boot defines: the chat door firing `team-chat`, which is how the
 * person in the chat reaches the agent. The template is the boot's own, so this is the production instruction.
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
		description: "Send a message or build a widget from inside a script.",
		parameters: Type.Object({
			message: Type.Optional(Type.String()),
			widget: Type.Optional(Type.Boolean()),
		}),
		execute: async ({ message, widget }, api, context) => {
			const nested =
				widget === true
					? await api.executeTool(WIDGET_TOOL, { css: "body { color: red }", html: ["<p>hi</p>"] }, context)
					: await api.executeTool(REPLY_TOOL, { message: message ?? "" }, context);
			answers.push({
				isError: nested.isError,
				text: typeof nested.structuredOutput === "string" ? nested.structuredOutput : "",
			});
			return { output: [{ type: "text", text: "script ran" }], details: {} };
		},
	});
	return defineExtension({ name: "scripted-delivery", tools: [tool] });
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
	assert.match(answers[0]?.text ?? "", /call reply from the turn/, "and what to do instead");
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
 * A fire carries an origin when the sender could name a conversation, and `reply` targets it: the person is in a chat,
 * and the model never names the chat's own tool. A fire with no origin — a schedule, a retry — records the reply and
 * says nobody was reached. Either way the gate counts the same call, because there is one operation and not two.
 */
test("a hooked turn answers with reply, and the gate counts the call", async () => {
	const directory = await temporary();
	const script = recorder([deliver("Привет!"), said("Done.")]);
	const { settled, requests, entries, transcript } = await runFired(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 2, "the model's own turn, and nothing added to it");
	assert.equal(reminded(requests), false, "the reply is the delivery, in a hooked turn as anywhere else");
	assert.equal(answerTo(entries, "sent").isError, false, "the call was not refused");
	assert.match(answerTo(entries, "sent").text, /nobody was reached/, "a fire with no conversation says so");
	assert.deepEqual(
		transcript.filter((item) => item.kind === "delivered").map((item) => (item as { text: string }).text),
		["Привет!"],
		"the console still reads what the turn recorded",
	);
});

test("a fire that named its conversation routes the reply back to it", async () => {
	const directory = await temporary();
	const script = recorder([deliver("Привет!"), said("Done.")]);
	const telegram = {
		enabled: true,
		connector: {
			user: {
				owner: "8811",
				conversations: [{ externalConversationId: "-1001234", kind: "room" }],
			},
			state: [],
			trustMarkers: false,
		},
	};
	const { setIntegrations } = await import("../src/server/integrations.ts");
	const { settled, entries } = await runTurn(directory, script, [], async (runtime) => {
		// The operator's configuration, as the boot would have it: the reply can only name a connector that exists.
		setIntegrations({ telegram: telegram as never });
		fires += 1;
		return runtime.hooks.fire("team-chat", {
			payload: "Привет",
			requestId: `delivery-gate:routed:${fires}`,
			origin: { connector: "telegram", externalConversationId: "-1001234", externalMessageId: "m1" },
		});
	});
	try {
		assert.equal(settled.status, "done");
		const reply = entries.find((entry) => entry.kind === "app.reply");
		assert.deepEqual((reply?.data as { target?: unknown }).target, {
			connector: "telegram",
			externalConversationId: "-1001234",
		});
		const hook = entries.find((entry) => entry.kind === "app.hook");
		assert.deepEqual((hook?.data as { origin?: unknown }).origin, {
			connector: "telegram",
			externalConversationId: "-1001234",
			externalMessageId: "m1",
		});
	} finally {
		setIntegrations({});
	}
});

test("a hooked turn that says nothing is reminded, and the reminder names reply", async () => {
	const directory = await temporary();
	const script = recorder([said("I will look into it."), deliver("Привет!"), said("Done.")]);
	const { settled, requests } = await runFired(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 3, "one reminder, one answer, no more");
	const reminder = requests[1]?.at(-1) as { role?: string; content?: unknown } | undefined;
	assert.equal(reminder?.role, "user");
	assert.equal(reminder?.content, DELIVERY_REMINDER, "the same reminder, because there is the same one tool");
	assert.match(String(reminder?.content), /`reply`/);
});

test("a console turn still delivers with reply while a chat-facing hook exists", async () => {
	const directory = await temporary();
	const script = recorder([deliver("Standup moved to nine."), said("Done.")]);
	const { settled, requests, entries, transcript } = await runScripted(directory, script, "Anything new?");

	assert.equal(settled.status, "done");
	assert.equal(answerTo(entries, "sent").isError, false, "the console turn's delivery is not refused");
	assert.equal(answerTo(entries, "sent").text, "delivered to the operator console");
	assert.equal(requests.length, 2, "no reminder: the console is this turn's reader");
	assert.deepEqual(
		transcript.filter((item) => item.kind === "delivered").map((item) => (item as { text: string }).text),
		["Standup moved to nine."],
	);
});
