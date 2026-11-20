import assert from "node:assert/strict";
import { test } from "node:test";
import { runConformance } from "../src/testkit/index.ts";
import { calculator } from "./fixtures/calculator.ts";

test("a tools-only connector passes the published conformance suite", async () => {
	const result = await runConformance(calculator);
	assert.deepEqual(
		result.failed.map((failure) => `${failure.name}: ${failure.error.message}`),
		[],
	);
	assert.ok(result.passed.length > 0, "the suite ran something");
	assert.ok(
		result.passed.some((name) => name.startsWith("session/")),
		"the session cases ran: a handshake needs no face of its own",
	);
	assert.ok(
		result.passed.includes("submission/an append with no address is accepted and answers nobody"),
		"a submission with no origin needs no face: the door refuses it, not the suite",
	);
	assert.ok(
		result.skipped.some((name) => name.startsWith("event/")),
		"a tool server raises no event",
	);
});
