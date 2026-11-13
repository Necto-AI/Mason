/**
 * The conversation as state on the wire: the snapshot a hold begins with, the diffs that follow it, the row in flight
 * under the id it commits with, and the revision that makes a reconnect safe.
 *
 * The socket is the point. What a client actually receives is Chord's `snap`/`ops` stream over a websocket the
 * credential opened, and every case here reads that stream: a number taken from the projection would be a number about
 * mason, not about the wire a client renders.
 *
 * `Client` below is the rule such a client follows, stated once where a test can disagree with it: hold the snapshot it
 * is handed, apply each diff to a copy of that state, and keep the result only when its `revision` is greater than the
 * one held. The revision travels inside the state — Chord's diff frame carries ops, not a sequence number — so the rule
 * is "apply, then judge", and a client that judged before applying would need a field the wire does not have.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { StateEvent } from "@earendil-works/chord";
import { apply } from "@earendil-works/chord/delta";
import type { ConversationState } from "mason-protocol";
import { holdPeer, replyTurns, serveConnector, until } from "./support/connector.ts";

/** The answer the streaming case measures: long enough that a paced provider has several chunks to publish. */
const ANSWER = "The deploy is healthy and the migration is done. ".repeat(8).trim();

/** What this run measured, recorded before it asserts so a failing run still prints the numbers. */
const measured: { updatesPerTurn?: number; meanIntervalMs?: number; chars?: number; firstUpdateMs?: number } = {};

after(() => {
	if (measured.updatesPerTurn === undefined) return;
	console.log(
		`[stream] updates-per-turn ${measured.updatesPerTurn} chars ${measured.chars ?? "?"} ` +
			`first-update-ms ${measured.firstUpdateMs?.toFixed(0) ?? "?"} ` +
			`mean-interval-ms ${measured.meanIntervalMs?.toFixed(1) ?? "?"}`,
	);
});

/**
 * The client's rule: a snapshot replaces what is held, a diff is applied to a copy of it, and the result is kept only
 * when it is a later revision. Every accepted state is kept, because a case here asks what the client saw when, which
 * is not the same question as what the last frame carried.
 */
class Client {
	/** The states it accepted, oldest first, with when each one arrived. */
	readonly states: Array<{ at: number; state: ConversationState }> = [];
	/** The revisions it refused because it already held one at least as new. */
	readonly refused: number[] = [];
	private held: ConversationState | undefined;

	read(frame: StateEvent<ConversationState>): void {
		const at = performance.now();
		if (frame.type !== "ops") {
			this.held = structuredClone(frame.value);
			this.states.push({ at, state: this.held });
			return;
		}
		const applied = apply(structuredClone(this.held), frame.ops) as ConversationState;
		if (this.held !== undefined && applied.revision <= this.held.revision) {
			this.refused.push(applied.revision);
			return;
		}
		this.held = applied;
		this.states.push({ at, state: applied });
	}

	get value(): ConversationState | undefined {
		return this.held;
	}

	/** The revisions it accepted, in order. */
	get revisions(): number[] {
		return this.states.map((entry) => entry.state.revision);
	}
}

/** The delivered row in flight in one state, when there is one: the row a person watches being written. */
function streamingRow(state: ConversationState | undefined): { id: string; text: string } | undefined {
	for (let index = (state?.transcript.length ?? 0) - 1; index >= 0; index -= 1) {
		const row = state?.transcript[index];
		if (row?.kind === "delivered" && row.streaming === true) return { id: row.id, text: row.text };
	}
	return undefined;
}

/** The delivered rows that have committed. */
function committed(state: ConversationState | undefined): Array<{ id: string; text: string }> {
	return (state?.transcript ?? []).flatMap((row) =>
		row.kind === "delivered" && row.streaming !== true ? [{ id: row.id, text: row.text }] : [],
	);
}

/** Feed everything a hold has received into the client, and remember how far it read. */
function pump(client: Client, frames: readonly StateEvent<ConversationState>[], cursor: { at: number }): void {
	while (cursor.at < frames.length) {
		client.read(frames[cursor.at] as StateEvent<ConversationState>);
		cursor.at += 1;
	}
}

/** Every transition the client was told about, in the order it was told. */
function told(client: Client): Array<Record<string, unknown>> {
	return client.states.flatMap((entry) => entry.state.transitions as unknown as Array<Record<string, unknown>>);
}

describe("the conversation a connector holds", () => {
	it("streams the row it commits under one id, and every later frame is a diff", async () => {
		const served = await serveConnector({ steps: replyTurns([ANSWER, "Short answer."]), tokensPerSecond: 120 });
		try {
			const peer = await holdPeer(served);
			try {
				const client = new Client();
				const cursor = { at: 0 };
				// The client holds before the turn starts, the way a chat window is open before anybody types.
				await until(() => peer.frames.length > 0, "the snapshot a hold begins with");
				pump(client, peer.frames, cursor);
				await peer.ref.append({
					type: "submission",
					appendId: "state-turn-1",
					content: [{ type: "text", text: "Is the deploy healthy?" }],
				});
				await until(
					() => {
						pump(client, peer.frames, cursor);
						return committed(client.value).length >= 1 && client.value?.busy === false;
					},
					"the first turn to end",
					20_000,
				);
				await peer.ref.append({
					type: "submission",
					appendId: "state-turn-2",
					content: [{ type: "text", text: "And once more?" }],
				});
				await until(
					() => {
						pump(client, peer.frames, cursor);
						return committed(client.value).length >= 2 && client.value?.busy === false;
					},
					"the second turn to end",
					20_000,
				);
				pump(client, peer.frames, cursor);

				assert.equal(peer.frames[0]?.type, "snap", "a hold begins with the state itself, not with a diff");
				assert.ok(
					peer.frames.every((frame) => frame.type !== "reset"),
					"a conversation that was not migrated does not reset a client's state",
				);
				assert.deepEqual(
					client.revisions,
					[...client.revisions].sort((left, right) => left - right),
					"the client applied each revision once, in order",
				);

				// A message is one row under one id: the row a person watches being written is the row that commits.
				const last = client.value as ConversationState;
				const rows = committed(last);
				assert.deepEqual(
					rows.map((row) => row.text),
					[ANSWER, "Short answer."],
					"one row per turn, in the order the turns ran",
				);
				const inFlight = client.states.flatMap((entry) => {
					const row = streamingRow(entry.state);
					return row === undefined ? [] : [row];
				});
				assert.ok(inFlight.length > 1, "the answer arrives as more than one update, which is what streaming is");
				assert.ok(
					inFlight.every((row) => ANSWER.startsWith(row.text)),
					"every update is the answer being written, so a client appends and never rebuilds",
				);
				assert.equal(inFlight.at(-1)?.id, rows[0]?.id, "the row in flight carries the id the row commits under");

				// The transitions name what happened, in the revision that reports it: the client reacts without diffing.
				const news = told(client);
				assert.deepEqual(
					news
						.filter((transition) => transition.kind === "message.committed")
						.map((transition) => transition.rowId),
					rows.map((row) => row.id),
					"each commit is reported once, naming the row it became",
				);
				// A run is a task id, and pi-durable hands a turn over mid-run: the task a turn starts under is not always
				// the one it stops under, so a client is told the replaced run ended before the one replacing it starts.
				// Counting kinds would hide a stop for a run nobody saw start, so the ids are what this walks.
				const runs = news.filter((one) => one.kind === "run.started" || one.kind === "run.stopped");
				const open: string[] = [];
				for (const run of runs) {
					const id = run.runTaskId as string;
					if (run.kind === "run.started") open.push(id);
					else assert.equal(open.pop(), id, "a run that stops is the run the client was told started");
				}
				assert.deepEqual(open, [], "every run the client was told started was also told stopped");
				assert.ok(
					runs.filter((one) => one.kind === "run.started").length > 2,
					"a handed-over turn tells the client about the task it replaced, so two turns are more than two runs",
				);
				assert.equal(
					news.filter((one) => one.kind === "run.errored").length,
					0,
					"a turn that answered did not error",
				);
				for (const transition of news) {
					const state = client.states.find((entry) => entry.state.revision === transition.revision)?.state;
					assert.ok(
						state?.transitions.some(
							(held) => held === (transition as unknown as ConversationState["transitions"][number]),
						),
						"a transition arrives in the revision it names",
					);
				}
			} finally {
				await peer.close();
			}
		} finally {
			await served.close();
		}
	});
	it("re-snapshots on a reconnect, drops a diff it already applied, and goes on with diffs", async () => {
		const served = await serveConnector({ steps: replyTurns(["The deploy is healthy.", "And the migration too."]) });
		try {
			const first = await holdPeer(served);
			const client = new Client();
			const cursor = { at: 0 };
			await until(() => first.frames.length > 0, "the snapshot a hold begins with");
			pump(client, first.frames, cursor);
			await first.ref.append({
				type: "submission",
				appendId: "state-reconnect-1",
				content: [{ type: "text", text: "Is the deploy healthy?" }],
			});
			await until(
				() => {
					pump(client, first.frames, cursor);
					return committed(client.value).length >= 1 && client.value?.busy === false;
				},
				"the first turn to end",
				15_000,
			);
			pump(client, first.frames, cursor);
			const held = client.value as ConversationState;
			const stale = first.frames.findIndex((frame) => frame.type === "ops");
			assert.ok(stale >= 0, "the first hold carried at least one diff to replay");
			await first.close();

			const second = await holdPeer(served);
			// A new hold is a new frame list, so the client reads it from its own first frame: the cursor belongs to a hold.
			const resumedCursor = { at: 0 };
			try {
				await until(() => second.frames.length > 0, "the snapshot of the new hold");
				pump(client, second.frames, resumedCursor);
				assert.equal(second.frames[0]?.type, "snap", "a re-hold begins with the state, before any diff");
				const resumed = client.value as ConversationState;
				// The comparison holds within one mason process: a restart begins the counter again at 0, and the snapshot is
				// applied whatever revision it carries, which is what converges the client across one.
				assert.ok(
					resumed.revision >= held.revision,
					"within one process, the state a reconnecting client is handed is at least as new as the one it held",
				);

				// Replaying a diff from before the reconnect is what a client must survive: it is not a later revision.
				client.read(second.frames[0] as StateEvent<ConversationState>);
				client.read(first.frames[stale] as StateEvent<ConversationState>);
				assert.equal(
					client.value?.revision,
					resumed.revision,
					"a diff from the hold before the reconnect is already applied",
				);

				await second.ref.append({
					type: "submission",
					appendId: "state-reconnect-2",
					content: [{ type: "text", text: "And the migration?" }],
				});
				await until(
					() => {
						pump(client, second.frames, resumedCursor);
						return committed(client.value).length >= 2 && client.value?.busy === false;
					},
					"the second turn to end",
					15_000,
				);
				assert.ok(
					second.frames.slice(1).some((frame) => frame.type === "ops"),
					"the frames after the snapshot are diffs, not a snapshot per change",
				);
				assert.equal(committed(client.value).length, 2, "two turns, two messages, one row each");
				const later = told(client).filter((transition) => (transition.revision as number) > held.revision);
				assert.deepEqual(
					later
						.filter((transition) => transition.kind === "message.committed")
						.map((transition) => transition.rowId),
					committed(client.value)
						.map((row) => row.id)
						.slice(1),
					"the new hold reports the second turn's message, naming the row it became",
				);
			} finally {
				await second.close();
			}
		} finally {
			await served.close();
		}
	});

	it("records how often a turn streams and how far apart its updates are", async () => {
		const served = await serveConnector({ steps: replyTurns([ANSWER]), tokensPerSecond: 120 });
		try {
			const peer = await holdPeer(served);
			try {
				const client = new Client();
				const cursor = { at: 0 };
				await until(() => peer.frames.length > 0, "the snapshot a hold begins with");
				pump(client, peer.frames, cursor);
				// The wait a person sits through: from the append mason claimed to the first words on screen.
				const claimed = performance.now();
				await peer.ref.append({
					type: "submission",
					appendId: "state-measure-1",
					content: [{ type: "text", text: "Is the deploy healthy?" }],
				});
				await until(
					() => {
						pump(client, peer.frames, cursor);
						return committed(client.value).length >= 1 && client.value?.busy === false;
					},
					"the turn to end",
					20_000,
				);
				const streamed = client.states.flatMap(({ at, state }) => {
					const row = streamingRow(state);
					return row === undefined ? [] : [{ at, text: row.text }];
				});
				const updates = streamed.filter((row, index) => index === 0 || row.text !== streamed[index - 1]?.text);
				measured.firstUpdateMs = updates[0] === undefined ? undefined : Math.max(0, updates[0].at - claimed);
				const intervals = updates.slice(1).map((row, index) => row.at - (updates[index]?.at ?? row.at));
				measured.updatesPerTurn = updates.length;
				measured.meanIntervalMs =
					intervals.length === 0 ? 0 : intervals.reduce((a, b) => a + b, 0) / intervals.length;
				measured.chars = updates.at(-1)?.text.length;
				assert.ok(
					updates.length > 1,
					"the answer reaches a client in more than one update: a pace is what makes the stream observable",
				);
				assert.deepEqual(
					updates.map((row) => row.text.length),
					updates.map((row) => row.text.length).sort((left, right) => left - right),
					"an update only ever adds to the message",
				);
				assert.equal(committed(client.value)[0]?.text, ANSWER, "and the row that commits is the whole answer");
			} finally {
				await peer.close();
			}
		} finally {
			await served.close();
		}
	});
});
