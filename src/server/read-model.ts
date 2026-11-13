/**
 * The conversation a person reads, as one value with a revision: what `mason.peer`'s `conversation` member publishes.
 *
 * Four things live here, and they are one publish: the memoised transcript the fold hands over, the queue, the run, and
 * the transitions that say what changed since the revision before. A client applies the snapshot it is handed and every
 * later frame whose revision is greater than the one it holds; a revision that is not greater is one it already applied.
 *
 * A value is only published when something a reader sees actually changed. That is not an optimisation: a `replace` with
 * an equal value publishes a whole replacement of a state nobody changed, and a revision is a claim that something
 * happened.
 */
import type { ConversationView } from "@earendil-works/pi-durable";
import type { ConversationState, ConversationTransition } from "mason-protocol";
import { foldTranscript, projectQueued, type TranscriptFold } from "./projection.ts";
import { deriveRunStatus, isBusy, liveOf } from "./status.ts";

/** The empty conversation: revision zero, nothing to read, nothing to report. */
const EMPTY: ConversationState = { revision: 0, transcript: [], queue: [], run: "idle", busy: false, transitions: [] };

export interface ReadModel {
	/** The last published value: what a peer's state member starts from. */
	readonly value: ConversationState;
	/** The value this view publishes, or `value` itself when nothing a reader sees changed. */
	next(view: ConversationView | undefined): ConversationState;
}

/** One revision's state without its number: what the publish guard compares and the transitions are derived from. */
interface Change extends Omit<ConversationState, "revision" | "transitions"> {
	readonly failedRunTaskId?: string;
}

/** One read model per process: the projection is the conversation's, and every connector reads the same one. */
export function createReadModel(): ReadModel {
	let value = EMPTY;
	let fold: TranscriptFold | undefined;
	/** Whether a value has been handed out: the first is the snapshot a client starts from, so it reports no transition. */
	let published = false;
	return {
		get value() {
			return value;
		},
		next(view) {
			const folded = foldTranscript(view, fold);
			fold = folded.fold;
			const live = liveOf(view);
			const busy = isBusy(view);
			const taskId = busy ? live?.run?.taskId : undefined;
			const change: Change = {
				transcript: [...folded.fold.items, ...folded.tail],
				queue: projectQueued(view),
				run: deriveRunStatus(view),
				busy,
				activeRunTaskId: taskId === undefined ? undefined : String(taskId),
				...(live?.runFailure === undefined ? {} : { failedRunTaskId: String(live.runFailure.taskId) }),
			};
			if (unchanged(value, change)) {
				published = true;
				return value;
			}
			const revision = value.revision + 1;
			const transitions = published ? transitionsOf(value, change, revision) : [];
			published = true;
			value = {
				revision,
				transcript: change.transcript,
				queue: change.queue,
				run: change.run,
				busy: change.busy,
				...(change.activeRunTaskId === undefined ? {} : { activeRunTaskId: change.activeRunTaskId }),
				transitions,
			};
			return value;
		},
	};
}

/** Whether a revision would say the same thing to a reader: the check that keeps a revision a report of a change. */
function unchanged(before: ConversationState, after: Change): boolean {
	return (
		before.run === after.run &&
		before.busy === after.busy &&
		before.activeRunTaskId === after.activeRunTaskId &&
		sameRows(before.transcript, after.transcript) &&
		sameRows(before.queue, after.queue)
	);
}

/**
 * Two row lists say the same thing when every row does. Rows are flat, so one comparison covers a row of any kind — and
 * the identity check first is what makes a committed row free: the fold hands the previous revision's object back.
 */
function sameRows(left: readonly object[], right: readonly object[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((row, index) => {
		const mine = row as Record<string, unknown>;
		const other = right[index] as Record<string, unknown>;
		if (mine === other) return true;
		const keys = Object.keys(mine);
		return keys.length === Object.keys(other).length && keys.every((key) => mine[key] === other[key]);
	});
}

/**
 * What changed between two values, named by the revision that reports it.
 *
 * Derived from the two projections rather than from the entries, so a transition cannot claim something the transcript
 * does not show. The order is the order a client wants to react in: a run starts, its message commits, the queue moves,
 * and a run that ended ends last — never both stopped and errored, because an ended run either failed or did not, and
 * `pi.live.runFailure` is what says which.
 */
function transitionsOf(before: ConversationState, after: Change, revision: number): ConversationTransition[] {
	const news: ConversationTransition[] = [];
	if (!before.busy && after.busy && after.activeRunTaskId !== undefined) {
		news.push({ kind: "run.started", revision, runTaskId: after.activeRunTaskId });
	}
	const known = new Set(before.transcript.map((row) => row.id));
	for (const row of after.transcript) {
		// Only a committed row is a message: the row streaming under the same id is the one that will commit.
		if (row.kind !== "delivered" || row.streaming === true || known.has(row.id)) continue;
		news.push({ kind: "message.committed", revision, rowId: row.id });
	}
	const queued = new Set(before.queue.map((item) => item.id));
	const waiting = new Set(after.queue.map((item) => item.id));
	for (const item of after.queue) {
		if (!queued.has(item.id)) news.push({ kind: "queue.added", revision, queueId: item.id });
	}
	for (const item of before.queue) {
		// A submission leaves the queue either way: the person took it back, or the inbox turned it into an entry.
		if (!waiting.has(item.id)) news.push({ kind: "queue.withdrawn", revision, queueId: item.id });
	}
	if (before.busy && !after.busy) {
		const errored = after.failedRunTaskId !== undefined && after.failedRunTaskId === before.activeRunTaskId;
		news.push({
			kind: errored ? "run.errored" : "run.stopped",
			revision,
			...(before.activeRunTaskId === undefined ? {} : { runTaskId: before.activeRunTaskId }),
		});
	}
	return news;
}
