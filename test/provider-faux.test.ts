/**
 * `fauxSessionScript` — the script a bot served under `PI_FAUX_MODEL=1` answers from.
 *
 * This exists because the queue used to be empty in the serving path and, once it was filled, because text alone is not
 * an answer: the only thing that reaches a reader is the `send` tool, so a script of plain answers runs a turn that
 * nobody is told about. A process that looks alive and cannot speak is worse than one that refuses to start, so both
 * halves — the delivery call and the round that closes the turn — are pinned here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxSessionScript } from "../src/server/provider.ts";

/** The tool calls in one message, as `{name, arguments}`. */
function calls(message: { content: unknown }): Array<{ name: string; arguments: unknown }> {
	if (!Array.isArray(message.content)) return [];
	return message.content.filter(
		(part: { type?: string }) => part.type === "toolCall",
	) as Array<{ name: string; arguments: unknown }>;
}

test("a served bot's script delivers through send, then closes the turn", () => {
	const script = fauxSessionScript({});
	assert.equal(script.length, 2, "one delivery and one close, not a queue of one that a boot turn spends");

	const delivery = script[0] as unknown as { content: unknown };
	const closing = script[1] as unknown as { content: unknown };
	const [call] = calls(delivery);
	assert.equal(call?.name, "send", "text alone reaches nobody: the send call is the message");
	assert.deepEqual(call?.arguments, { text: "ok" });
	assert.equal(calls(closing).length, 0, "the closing round answers, it does not deliver twice");
});

test("the words and the count come from the environment, and a bad count is one answer", () => {
	const script = fauxSessionScript({ PI_FAUX_TEXT: "I am mason.", PI_FAUX_REPEAT: "3" });
	assert.equal(script.length, 6, "three turns, two rounds each");
	assert.deepEqual(calls(script[0] as unknown as { content: unknown })[0]?.arguments, { text: "I am mason." });

	for (const unreadable of ["", "nonsense", "0", "-4"]) {
		assert.equal(
			fauxSessionScript({ PI_FAUX_REPEAT: unreadable }).length,
			2,
			`"${unreadable}" is one turn, not a queue nobody can drain`,
		);
	}
	assert.equal(
		fauxSessionScript({ PI_FAUX_REPEAT: "100000" }).length,
		1000,
		"a cap, so a typo cannot hold a million messages",
	);
});
