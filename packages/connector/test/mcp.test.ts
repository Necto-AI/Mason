import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVAL, APPROVAL_META_KEY } from "@mason/protocol";
import { approvalMeta, declareTool, describeProblem, readApprovalMarker } from "../src/mcp.ts";

test("a tool declares its approval marker in mason's own namespace", () => {
	const tool = declareTool({
		name: "send_message",
		description: "Send one message to a Telegram chat.",
		inputSchema: { type: "object", properties: { chat_id: { type: "string" } } },
		approval: true,
	});
	const meta = tool._meta as Record<string, unknown>;
	assert.equal(meta[APPROVAL_META_KEY], APPROVAL.required);
	assert.equal(tool.name, "send_message");
});

test("a boolean is the marker, because that is what a hurried author writes", () => {
	assert.equal((approvalMeta(true) as Record<string, unknown>)[APPROVAL_META_KEY], APPROVAL.required);
	assert.equal((approvalMeta(false) as Record<string, unknown>)[APPROVAL_META_KEY], APPROVAL.notRequired);
	assert.equal((approvalMeta("not_required") as Record<string, unknown>)[APPROVAL_META_KEY], APPROVAL.notRequired);
});

test("a marker nobody wrote means required, and an unknown one means required", () => {
	assert.equal(readApprovalMarker(undefined), APPROVAL.required);
	assert.equal(readApprovalMarker({}), APPROVAL.required);
	assert.equal(readApprovalMarker({ [APPROVAL_META_KEY]: "probably_fine" }), APPROVAL.required);
	assert.equal(readApprovalMarker({ [APPROVAL_META_KEY]: APPROVAL.notRequired }), APPROVAL.notRequired);
	assert.equal(readApprovalMarker({ [APPROVAL_META_KEY]: APPROVAL.required }), APPROVAL.required);
});

test("a description is one line, and the check says why not rather than that it is wrong", () => {
	assert.equal(describeProblem("Send one message to a chat."), undefined);
	assert.match(describeProblem("   ") ?? "", /one line/);
	assert.match(describeProblem("two\nlines") ?? "", /one line, not a paragraph/);
	assert.match(describeProblem("x".repeat(201)) ?? "", /belongs in the tool's own result/);
});
