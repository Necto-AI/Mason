/**
 * The operator's raw view of the conversation: the trace, granted separately from the conversation itself.
 *
 * `projection.ts` is the reader's wire and a whitelist: a person sees their words, the replies, the widgets and a
 * coarse failure, and nothing of the machine. This file is the other half of that decision — the entries as the durable
 * conversation holds them, forwarded only to a device the operator granted `trace` (`auth.ts`), and never through a
 * connector (`docs/SPEC.md` §4.2).
 *
 * Everything the model did is here because everything it did is an entry: the messages the model was sent and wrote
 * (`model`), the tool calls and their results (in those same messages), a hook's payload (`app.hook`), the permission
 * questions and answers, the deliveries and the chat commands, and the compaction entries and context edits — the
 * changes to what the model is asked next. There is no second store to read and nothing to reconstruct.
 */
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { Trace } from "../shared/admin.ts";

export function projectTrace(view: ConversationView | undefined): Trace {
	const entries = (view?.entries ?? []) as readonly EntryRecord[];
	const counts: { kind: string; count: number }[] = [];
	for (const entry of entries) {
		const seen = counts.find((candidate) => candidate.kind === entry.kind);
		if (seen === undefined) counts.push({ kind: entry.kind, count: 1 });
		else seen.count += 1;
	}
	return {
		conversationId: String(view?.conversation.id ?? ""),
		entries: entries.map((entry) => ({
			id: String(entry.id),
			kind: entry.kind,
			...(entry.model === undefined ? {} : { model: entry.model }),
			...(entry.data === undefined ? {} : { data: entry.data }),
			...(entry.head === undefined ? {} : { head: String(entry.head) }),
			...(entry.edits === undefined ? {} : { edits: entry.edits }),
			...(entry.byTaskId === undefined ? {} : { byTaskId: String(entry.byTaskId) }),
		})),
		kinds: counts,
	};
}
