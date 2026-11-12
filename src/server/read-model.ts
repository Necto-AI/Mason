/**
 * The conversation a person reads, as one value with a revision: what `mason.peer`'s `conversation` member publishes.
 *
 * Four things live here, and they are one module because they are one publish: the memoised transcript, the queue, the
 * run token, and the transitions that say what changed since the revision before. A client applies the snapshot it is
 * handed and every later frame whose revision is greater than the one it holds; a revision that is not greater is one it
 * has already applied.
 *
 * The memo is the point of the fold (`projection.ts`): a token appended to the reply in flight must publish a tail diff,
 * not a transcript. A value is only published when something a reader sees actually changed, because a `replace` with an
 * equal value would publish a whole replacement of a state nobody changed — and because a revision is a claim that
 * something happened.
 */
import type { ConversationView } from "@earendil-works/pi-durable";
import type { ConversationState, ConversationTransition } from "mason-protocol";
import type { QueuedItem, TranscriptItem } from "../shared/contract.ts";
import { type TranscriptFold, foldTranscript, projectQueued } from "./projection.ts";
import { deriveRunStatus, isBusy, liveOf } from "./status.ts";

/** The empty conversation: revision zero, nothing to read, nothing to report. */
const EMPTY: ConversationState = { revision: 0, transcript: [], queue: [], run: "idle", busy: false, transitions: [] };

export interface ReadModel {
	/** The last published value: what a peer's state member starts from. */
	readonly value: ConversationState;
	/**
	 * The value this view publishes: `value` itself when nothing a reader sees changed, which is what keeps an
	 * unchanged commit from becoming a revision nobody can see.
	 */
	next(view: ConversationView | undefined): ConversationState;
}

/** One read model per process: the projection is the conversation's, and every connector reads the same one. */
export function createReadModel(): ReadModel {
	let value = EMPTY;
	let fold: TranscriptFold | undefined;
	/** Whether anything has been handed out yet: the first value is the snapshot a client starts from, not a change. */
	let called = false;
	return {
		get value() {
			return value;
		},
		next(view) {
			const folded = foldTranscript(view, fold);
			fold = folded.fold;
			const transcript = [...folded.fold.items, ...folded.tail];
			const queue = projectQueued(view);
			const run = deriveRunStatus(view);
			const busy = isBusy(view);
			const live = liveOf(view);
			const runTaskId = busy ? live?.run?.taskId : undefined;
			const activeRunTaskId = runTaskId === undefined ? undefined : String(runTaskId);
			// The commit that ends a run either records why it ended without an answer or it does not: `pi.live` says which,
			// and it says it in that same commit, so a client is told the truth rather than a guess from the transcript.
			const failedRunTaskId = live?.runFailure === undefined ? undefined : String(live.runFailure.taskId);
			if (sameState(value, { transcript, queue, run, busy, activeRunTaskId })) {
				called = true;
				return value;
			}
			const revision = value.revision + 1;
			// Read before the assignment: `transitionsOf` reads the value this one replaces.
			const transitions = called
				? transitionsOf(value, { transcript, queue, busy, activeRunTaskId, failedRunTaskId }, revision)
				: [];
			called = true;
			value = {
				revision,
				transcript,
				queue,
				run,
				busy,
				...(activeRunTaskId === undefined ? {} : { activeRunTaskId }),
				transitions,
			};
			return value;
		},
	};
}

/** What a revision publishes, without the numbers that make it a revision. */
interface Change {
	readonly transcript: readonly TranscriptItem[];
	readonly queue: readonly QueuedItem[];
	readonly run: ConversationState["run"];
	readonly busy: boolean;
	readonly activeRunTaskId: string | undefined;
	/** The run `pi.live` says ended without an answer, when it does: the one an ending is errored for. */
	readonly failedRunTaskId?: string | undefined;
}

/** Whether two values say the same thing to a reader: the check that keeps a revision a report of a change. */
function sameState(before: ConversationState, after: Change): boolean {
	return (
		before.run === after.run &&
		before.busy === after.busy &&
		before.activeRunTaskId === after.activeRunTaskId &&
		sameRows(before.transcript, after.transcript) &&
		sameRows(before.queue, after.queue)
	);
}

/** Two row lists are the same list when every row says the same thing. Rows are flat, so one comparison covers them. */
function sameRows(left: readonly object[], right: readonly object[]): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	return left.every((row, index) => {
		const other = right[index] as Record<string, unknown>;
		const mine = row as Record<string, unknown>;
		const keys = Object.keys(mine);
		return keys.length === Object.keys(other).length && keys.every((key) => mine[key] === other[key]);
	});
}

/**
 * What changed between two values, named by the revision that reports it.
 *
 * Derived from the two projections rather than from the entries, so a transition cannot claim something the transcript
 * does not show. The order is the order a client wants to react in: a run starts, its message commits, the queue moves,
 * and a run that ended ends last — never both stopped and errored, because an ended run either failed or did not.
 *
 * The first value a read model hands out is the snapshot a client starts from, and it reports nothing: there is no
 * revision before it for a transition to have happened in.
 */
function transitionsOf(before: ConversationState, after: Omit<Change, "run">, revision: number): ConversationTransition[] {
	const known = new Set(before.transcript.map((row) => row.id));
	const transitions: ConversationTransition[] = [];
	if (!before.busy && after.busy && after.activeRunTaskId !== undefined) {
		transitions.push({ kind: "run.started", revision, runTaskId: after.activeRunTaskId });
	}
	for (const row of after.transcript) {
		// Only a committed row is a message: the row streaming under the same id is the one that will commit.
		if (row.kind !== "delivered" || row.streaming === true || known.has(row.id)) continue;
		transitions.push({ kind: "message.committed", revision, rowId: row.id });
	}
	const queued = new Set(before.queue.map((item) => item.id));
	const waiting = new Set(after.queue.map((item) => item.id));
	for (const item of after.queue) {
		if (!queued.has(item.id)) transitions.push({ kind: "queue.added", revision, queueId: item.id });
	}
	for (const item of before.queue) {
		// A submission leaves the queue either way: the person took it back, or the inbox turned it into an entry.
		if (!waiting.has(item.id)) transitions.push({ kind: "queue.withdrawn", revision, queueId: item.id });
	}
	if (before.busy && !after.busy) {
		const errored = after.failedRunTaskId !== undefined && after.failedRunTaskId === before.activeRunTaskId;
		transitions.push({
			kind: errored ? "run.errored" : "run.stopped",
			revision,
			...(before.activeRunTaskId === undefined ? {} : { runTaskId: before.activeRunTaskId }),
		});
	}
	return transitions;
}
