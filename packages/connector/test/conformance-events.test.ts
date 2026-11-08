import assert from "node:assert/strict";
import { test } from "node:test";
import { runConformance } from "../src/testkit/index.ts";
import { alarm } from "./fixtures/alarm.ts";

test("an events-only connector passes the published conformance suite", async () => {
	const result = await runConformance(alarm);
	assert.deepEqual(
		result.failed.map((failure) => `${failure.name}: ${failure.error.message}`),
		[],
	);
	assert.ok(
		result.passed.some((name) => name.startsWith("event/")),
		"the event cases ran",
	);
	assert.ok(
		result.passed.some((name) => name.startsWith("submission/")),
		"an alarm may still hand mason a person's words",
	);
	assert.ok(
		result.skipped.some((name) => name.startsWith("delivery/")),
		"an alarm has no target, so nothing is delivered to it",
	);
});
