/**
 * The four commands, as a chat meets them: what each one calls, what it answers, and what it refuses to do twice.
 *
 * The conversation is a stub here, which is the point: the dispatch is a function over five ports (`CommandTarget`), so
 * a test can read what `/stop` did without a provider, a turn or a clock. The real conversation is exercised at the door
 * (`test/events.test.ts`), and the sentence `/status` answers with is derived in `status.ts` — pinned at the end of this
 * file against synthetic views, because a status line is arithmetic over what the client already shows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { CommandName } from "../src/server/events.ts";
import type { IntegrationSummary } from "../src/server/integration-status.ts";
import { runCommand, type CommandTarget } from "../src/server/main.ts";
import { statusLine } from "../src/server/status.ts";

const IDLE = "idle: nothing queued; no integration connected; nothing unreachable since boot";

interface Ran {
	abort: number;
	clear: number;
	compact: (string | undefined)[];
	status: number;
}

/** A target that records what it was asked to do, and a claim that answers the same thing every time. */
function stub(options: { readonly claimed?: boolean; readonly status?: string } = {}): {
	readonly target: CommandTarget;
	readonly ran: Ran;
	readonly claims: { requestId: string; command: CommandName; argument: string | undefined }[];
} {
	const ran: Ran = { abort: 0, clear: 0, compact: [], status: 0 };
	const claims: { requestId: string; command: CommandName; argument: string | undefined }[] = [];
	const claimed = options.claimed ?? true;
	const target: CommandTarget = {
		abort: async () => {
			ran.abort += 1;
		},
		clear: async () => {
			ran.clear += 1;
		},
		compact: async (instructions) => {
			ran.compact.push(instructions);
		},
		status: async () => {
			ran.status += 1;
			return options.status ?? IDLE;
		},
		claim: async (requestId, command, argument) => {
			claims.push({ requestId, command, argument });
			return claimed;
		},
	};
	return { target, ran, claims };
}

describe("a command, dispatched", () => {
	it("stops, compacts, clears and answers status, each with the line the chat reads", async () => {
		const stop = stub();
		assert.equal(await runCommand(stop.target, "command:telegram:1", "stop", undefined), "stopped");
		assert.deepEqual(stop.ran, { abort: 1, clear: 0, compact: [], status: 0 });

		const compact = stub();
		assert.equal(
			await runCommand(compact.target, "command:telegram:2", "compact", "keep the pricing thread"),
			"compacted",
		);
		assert.deepEqual(compact.ran.compact, ["keep the pricing thread"]);

		const clear = stub();
		assert.equal(await runCommand(clear.target, "command:telegram:3", "clear", undefined), "cleared");
		assert.deepEqual(clear.ran, { abort: 0, clear: 1, compact: [], status: 0 });

		const status = stub();
		assert.equal(await runCommand(status.target, "command:telegram:4", "status", undefined), IDLE);
		assert.deepEqual(status.ran, { abort: 0, clear: 0, compact: [], status: 1 });
	});

	it("answers a redelivery with nothing, because the first delivery already answered", async () => {
		// The log holds the claim, so the second delivery must not clear or compact again — and must not tell the chat that it
		// did. An empty reply is no reply: the relay suppresses it, so the person sees one answer for one command, and the
		// audit line says `already ran` rather than claiming an act that did not happen.
		const again = stub({ claimed: false });
		assert.equal(await runCommand(again.target, "command:telegram:compact-1", "compact", "the pricing thread"), undefined);
		assert.equal(await runCommand(again.target, "command:telegram:clear-1", "clear", undefined), undefined);
		assert.deepEqual(again.ran, { abort: 0, clear: 0, compact: [], status: 0 });
	});

	it("does not claim a status, because it changes nothing", async () => {
		const status = stub({ claimed: false });
		assert.equal(await runCommand(status.target, "command:telegram:5", "status", undefined), IDLE);
		assert.deepEqual(status.claims, [], "a claim would be a record of something that did not happen");
		assert.equal(status.ran.status, 1);
	});
});

describe("the status line a chat reads", () => {
	function view(live: Record<string, unknown>, queued = 0): ConversationView {
		return {
			entries: [],
			docs: {
				"pi.live": live,
				...(queued === 0
					? {}
					: {
							"pi.inbox": {
								items: Array.from({ length: queued }, (_, index) => ({
									id: index + 1,
									mode: "followUp",
									content: { type: "input", content: "waiting" },
								})),
							},
						}),
			},
		} as unknown as ConversationView;
	}

	function integration(
		name: string,
		health: { connected?: boolean; error?: string; enabled?: boolean } = {},
	): IntegrationSummary {
		return {
			name,
			enabled: health.enabled ?? true,
			hasTools: true,
			hasTrigger: false,
			connected: health.connected ?? false,
			tools: health.connected === true ? 2 : 0,
			error: health.error ?? null,
		};
	}

	it("says what is running, what is waiting, and what answered at boot", () => {
		assert.equal(statusLine(view({}), []), IDLE);
		assert.equal(
			statusLine(view({ run: { taskId: 1, inputs: [] }, generation: { attempt: 1 } }, 2), [
				integration("telegram", { connected: true }),
				integration("github", { connected: true }),
				integration("docs", { error: 'MCP integration "docs" at http://mason-docs:8080/mcp: no route' }),
			]),
			"answering: 2 queued; telegram, github connected; 1 unreachable since boot",
		);
	});

	it("reads a retry first, because that is what the person has to know about", () => {
		assert.equal(
			statusLine(view({ run: { taskId: 1, inputs: [] }, generation: { attempt: 2, retry: { at: 0, error: "429" } } }), []),
			"retrying after a failure: nothing queued; no integration connected; nothing unreachable since boot",
		);
	});

	it("does not call a switched-off integration unreachable", () => {
		// A disabled entry is never attempted, so it has no error to report: the line says what is, not what would be.
		assert.equal(
			statusLine(view({}), [integration("off", { enabled: false })]),
			"idle: nothing queued; no integration connected; nothing unreachable since boot",
		);
	});
});
