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
		result.passed.includes("grant/an entry that grants no user refuses words"),
		"the no-user refusal ran, because this fixture's grant names an owner",
	);
	assert.ok(
		result.passed.some((name) => name.startsWith("journal/")),
		"the journal cases ran: a queued call is replayed whether or not the entry carries words",
	);
});
