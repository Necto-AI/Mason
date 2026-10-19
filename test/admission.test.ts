import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entryFor, entryKindFor, originOfEntryKind, whenBusyFor } from "../src/server/admission.ts";
import { scheduledRequestId } from "../src/server/hooks.ts";

describe("admission: an origin decides where an input waits", () => {
	it("maps each origin to the entry kind the transcript shows", () => {
		assert.equal(entryKindFor("user"), undefined);
		assert.equal(entryKindFor("hook"), "app.hook");
		assert.equal(entryKindFor("helper"), "app.helper");
		assert.equal(entryKindFor("routine"), "app.routine");
	});

	it("reads the origin back from the entry kind", () => {
		for (const origin of ["user", "hook", "helper", "routine"] as const) {
			assert.equal(originOfEntryKind(entryKindFor(origin)), origin);
		}
		// An entry kind mason does not know is still somebody's: the default is the user, who may steer.
		assert.equal(originOfEntryKind("app.unknown"), "user");
		assert.equal(originOfEntryKind(undefined), "user");
	});

	it("only the user may steer a running turn", () => {
		assert.equal(whenBusyFor("hook"), "followUp");
		assert.equal(whenBusyFor("hook", "steer"), "followUp");
		assert.equal(whenBusyFor("helper"), "followUp");
		assert.equal(whenBusyFor("routine", "steer"), "followUp");
		assert.equal(whenBusyFor("user"), "followUp");
		assert.equal(whenBusyFor("user", "steer"), "steer");
	});

	it("places a hook input as an app.hook entry carrying its trigger data", () => {
		assert.deepEqual(entryFor("hook", { hookId: "morning-brief" }), {
			kind: "app.hook",
			data: { hookId: "morning-brief" },
		});
		assert.equal(entryFor("user"), undefined);
	});
});

describe("hook fires are idempotent within their own identity", () => {
	it("gives one scheduled slot one key", () => {
		const hook = { id: "morning-brief", intervalMs: 86_400_000 };
		const noon = Date.UTC(2026, 9, 19, 12, 0, 0);
		assert.equal(scheduledRequestId(hook, noon), scheduledRequestId(hook, noon + 3_600_000));
		assert.notEqual(scheduledRequestId(hook, noon), scheduledRequestId(hook, noon + 86_400_000));
	});

	it("keeps two manual hooks apart", () => {
		const noon = Date.UTC(2026, 9, 19, 12, 0, 0);
		assert.notEqual(
			scheduledRequestId({ id: "workspace-check", intervalMs: 60_000 }, noon),
			scheduledRequestId({ id: "morning-brief", intervalMs: 60_000 }, noon),
		);
	});
});
