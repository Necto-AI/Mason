/**
 * `send_to_user` is the one channel the agent's words reach the reader through, so the registration facts the
 * durability rules depend on are pinned here: the replay policy, the unconditional registration, and the fact that
 * `execute()` delivers by returning.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { AgentIdentity } from "../src/server/extensions/agent-identity.ts";
import { Delivery, sendToUserTool } from "../src/server/extensions/delivery.ts";
import { BASE_EXTENSIONS, openAgentRuntime, type AgentRuntime } from "../src/server/runtime.ts";

test("send_to_user is replay-unsafe, so a restart never delivers the same message twice", () => {
	assert.equal(sendToUserTool.name, "send_to_user");
	// Explicit in the registration, though it is pi's default: an interrupted call settles as an `interrupted`
	// error result instead of rerunning, and a rerun would send the reader the message a second time.
	assert.equal(sendToUserTool.replay, "unsafe");
});

test("the delivery extension rides in the base extension list, not behind a toggle", () => {
	assert.deepEqual(
		Delivery.tools?.map((tool) => tool.name),
		["send_to_user"],
	);
	assert.ok(
		BASE_EXTENSIONS.some((extension) => extension.name === Delivery.name),
		"every conversation can speak",
	);
});

/** The same agent over the same storage in the same directory: a restart. */
function openRuntime(directory: string): Promise<AgentRuntime> {
	return openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		faux: true,
		enableSandboxedUi: false,
		onReport: () => {},
	});
}

test("a selection stored before delivery existed still speaks after a reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-stale-extensions-"));
	try {
		const before = await openRuntime(directory);
		try {
			// A `pi.agent` doc from before slice 1: an explicit array of names, without `delivery`. A stored array is
			// used verbatim, so nothing else brings delivery back.
			const root = await before.conversation();
			await root.configure({ extensions: [CodingTools, AgentIdentity] }, BACKGROUND_CONTEXT);
		} finally {
			await before.close();
		}

		const after = await openRuntime(directory);
		try {
			const agent = await (await after.conversation()).agent(BACKGROUND_CONTEXT);
			assert.deepEqual(
				agent.extensions.map((extension) => extension.name),
				["coding-tools", "agent-identity", "delivery"],
				"the missing base names are appended in base order, and the stored order survives",
			);
			assert.ok(
				agent.tools.some((tool) => tool.name === sendToUserTool.name),
				"the model is offered the one way it can reach the reader",
			);
		} finally {
			await after.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("execute only returns: the committed call is the delivery", async () => {
	const result = await sendToUserTool.execute({ message: "Standup moved to nine." }, {} as never, {} as never);
	assert.deepEqual(result, { output: [{ type: "text", text: "delivered" }], details: { length: 22 } });
	assert.equal(result.isError, undefined);
	assert.equal(result.control, undefined);
});
