/**
 * Admission: where a submission came from, and where it waits.
 *
 * The origin is read from the entry kind pi-durable already places, so the mapping is the whole policy — there is no
 * parallel field to keep in step. One rule falls out of it: only the user may steer, so a trigger source that asks to
 * steer is downgraded to a follow-up instead of talking over the person driving.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entryFor, entryKindFor, originOfEntryKind, whenBusyFor } from "../src/server/admission.ts";

describe("an input's origin", () => {
	it("maps both ways between an origin and the entry kind pi-durable places", () => {
		assert.equal(entryKindFor("user"), undefined, "the user's own text is pi's default entry, `pi.user`");
		assert.equal(entryKindFor("hook"), "app.hook");
		assert.equal(originOfEntryKind("app.hook"), "hook");
		assert.equal(originOfEntryKind("pi.user"), "user");
		assert.equal(originOfEntryKind(undefined), "user", "anything that is not a trigger kind is the user's");
		for (const origin of ["user", "hook"] as const) {
			assert.equal(originOfEntryKind(entryKindFor(origin)), origin, `${origin} round-trips through its kind`);
		}
	});

	it("builds the entry an origin is placed as", () => {
		assert.equal(entryFor("user"), undefined, "no entry is pi's default");
		assert.deepEqual(entryFor("hook"), { kind: "app.hook" });
		const data = { hookId: "workspace-check", payload: null };
		const entry = entryFor("hook", data);
		assert.deepEqual(entry, { kind: "app.hook", data: { hookId: "workspace-check", payload: null } });
		// The caller keeps its object: the next fire must not rewrite the entry already in the transcript.
		data.hookId = "morning-brief";
		assert.deepEqual(entry?.data, { hookId: "workspace-check", payload: null });
	});
});

describe("where an input waits", () => {
	it("lets the user steer, because the person driving may interrupt", () => {
		assert.equal(whenBusyFor("user", "steer"), "steer");
		assert.equal(whenBusyFor("user", "followUp"), "followUp");
		assert.equal(whenBusyFor("user"), undefined, "asking for nothing leaves pi's own default in place");
	});

	it("downgrades a hook's steer to a follow-up: a trigger source never steers", () => {
		assert.equal(whenBusyFor("hook", "steer"), "followUp");
		assert.equal(whenBusyFor("hook", "followUp"), "followUp");
		assert.equal(whenBusyFor("hook"), "followUp");
	});

	it("passes the user's own reject through: it is their refusal, not a placement policy", () => {
		assert.equal(whenBusyFor("user", "reject"), "reject");
		assert.equal(whenBusyFor("hook", "reject"), "followUp", "a hook has nobody to refuse for");
	});
});
