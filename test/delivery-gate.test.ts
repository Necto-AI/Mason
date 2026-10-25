/**
 * The reader never gets silence for an answer.
 *
 * `send_to_user` is a tool, so calling it is the model's choice and the prompt is only advice. These tests pin the
 * guarantee behind the advice: a turn that ends with nothing delivered continues once with a reminder, and a second
 * silent answer shows the reader a notice instead of nothing. The reminder itself is never part of the transcript.
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
import { DELIVERY_REMINDER, MESSAGE_TOOL } from "../src/shared/contract.ts";
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

async function runScripted(directory: string, script: ReturnType<typeof recorder>, prompt = "Anything new?") {
	const { access, faux } = fauxAccess();
	faux.setResponses(script.steps);
	const runtime: AgentRuntime = await openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		houseHome: join(directory, "house"),
		storage: "memory",
		modelAccess: access,
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
