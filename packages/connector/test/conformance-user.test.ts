import assert from "node:assert/strict";
import { test } from "node:test";
import { conformanceCases, runConformance } from "../src/testkit/index.ts";
import { chat } from "./fixtures/chat.ts";

test("a full user connector passes every case the suite has", async () => {
	const result = await runConformance(chat);
	assert.deepEqual(
		result.failed.map((failure) => `${failure.name}: ${failure.error.message}`),
		[],
	);
	const total = conformanceCases().length;
	assert.equal(result.passed.length + result.skipped.length, total, "every case either ran or was skipped for a face");
	assert.ok(result.passed.length >= total - 1, `a full connector skips almost nothing: ${result.skipped.join(", ")}`);
});
