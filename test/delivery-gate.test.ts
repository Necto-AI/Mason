/**
 * The reader never gets silence for an answer.
 *
 * `send_to_user` is a tool, so calling it is the model's choice and the prompt is only advice. These tests pin the
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
	fauxAssistantMessage,
	fauxProvider,
	type FauxResponseStep,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DELIVERY_REMINDER, MESSAGE_TOOL, WIDGET_TOOL } from "../src/shared/contract.ts";
import { projectTranscript } from "../src/server/projection.ts";
import { openAgentRuntime, type AgentRuntime, type ResolvedModel } from "../src/server/runtime.ts";

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
	return fauxAssistantMessage([fauxToolCall(MESSAGE_TOOL, { message }, { id })], { stopReason: "toolUse" });
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
			return typeof step === "function" ? step(context, undefined, { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] }, undefined as never) : step;
		};
	});
	return { steps: queue, requests };
}

async function runScripted(
	directory: string,
	script: ReturnType<typeof recorder>,
	prompt = "Anything new?",
	extensions: readonly Extension[] = [],
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
		const conversation = await runtime.conversation();
		const submission = await conversation.submit({ type: "input", content: prompt }, BACKGROUND_CONTEXT);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		const state = await runtime.viewSnapshot(BACKGROUND_CONTEXT);
		return { settled, transcript: projectTranscript(state), requests: script.requests };
	} finally {
		await runtime.close();
	}
}

/** Whether the gate ever nudged the model: the reminder is only ever an input the gate added. */
function reminded(requests: readonly (readonly Message[])[]): boolean {
	return requests.some((messages) => messages.some((message) => message.content === DELIVERY_REMINDER));
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
					: await api.executeTool(MESSAGE_TOOL, { message: message ?? "" }, context);
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
	const script = recorder([
		said("The standup moved to nine."),
		deliver("Standup moved to nine."),
		said("Done."),
	]);
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
	assert.match(answers[0]?.text ?? "", /send it with send_to_user directly/, "and what to do instead");
	assert.equal(reminded(requests), true, "the refusal is not a delivery, so the turn is still silent to the gate");
	assert.equal(requests.length, 4, "the reminder added one round, and no more");
	assert.deepEqual(
		transcript.filter((item) => item.kind === "delivered").map((item) => (item as { text: string }).text),
		["Standup moved to nine."],
		"the reader sees the message once, from the model's own call",
	);
});

test("a widget built from inside a script is refused the same way", async () => {
	const directory = await temporary();
	const answers: NestedAnswer[] = [];
	const script = recorder([
		call("deliverFromScript", { widget: true }, "run"),
		deliver("Here is the chart."),
		said("Done."),
	]);
	const { settled, transcript, requests } = await runScripted(directory, script, "Anything new?", [
		scriptedDelivery(answers),
	]);

	assert.equal(settled.status, "done");
	assert.equal(answers[0]?.isError, true, "the nested widget was refused, not rendered");
	assert.match(answers[0]?.text ?? "", /cannot render from inside a script/, "the refusal says what went wrong");
	assert.match(answers[0]?.text ?? "", /Call generateSandboxedUi directly/, "and what to do instead");
	assert.deepEqual(
		transcript.filter((item) => item.kind === "widget"),
		[],
		"nothing a script built reaches the reader",
	);
	assert.equal(reminded(requests), false, "the model's own message spoke for the turn");
	assert.deepEqual(
		transcript.filter((item) => item.kind === "delivered").map((item) => (item as { text: string }).text),
		["Here is the chart."],
	);
});
