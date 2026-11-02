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
		result.skipped.some((name) => name.startsWith("submission/")),
		"a tools-only connector has no submissions to be judged on",
	);
});
