/**
 * `send_to_user` is the one channel the agent's words reach the reader through, so the registration facts the
 * durability rules depend on are pinned here: the replay policy, the unconditional registration, and the fact that
 * `execute()` delivers by returning.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Delivery, sendToUserTool } from "../src/server/extensions/delivery.ts";
import { BASE_EXTENSIONS } from "../src/server/runtime.ts";

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

test("execute only returns: the committed call is the delivery", async () => {
	const result = await sendToUserTool.execute({ message: "Standup moved to nine." }, {} as never, {} as never);
	assert.deepEqual(result, { output: [{ type: "text", text: "delivered" }], details: { length: 22 } });
	assert.equal(result.isError, undefined);
	assert.equal(result.control, undefined);
});
