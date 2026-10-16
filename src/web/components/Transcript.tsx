/**
 * The transcript: the conversation's blocks, the running turn's bubbles, and the queue after them. Ported from
 * sibling's transcript view: the settled part is appended to (never rebuilt, so open `<details>` survive), while
 * the live part re-derives its bubbles from the streaming message and the running tools on every update.
 */
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { blockKey, groupEntries, turnPieces } from "../lib/transcript-model.ts";
import type { WidgetBridge } from "../lib/websandbox-loader.ts";
import { inbox as inboxOf, live as liveOf, usage as usageOf, type ConversationViewLike } from "../view-types.ts";
import { DebugSheet, LiveChips, UsagePanel } from "./DebugBits.tsx";
import { HookRow, LiveBubbles, NoteRow, SettledTurn, UserRow } from "./MessageRow.tsx";
import { QueuedRows } from "./QueuedRows.tsx";

/** The built-in hook the Retry control fires (`src/server/hooks.ts`). */
export const RETRY_HOOK_ID = "retry-failed-run";

export interface TranscriptProps {
	readonly view: ConversationViewLike | undefined;
	readonly busy: boolean;
	readonly debug: boolean;
	readonly bridgeFor: (callId: string) => WidgetBridge;
	readonly onWithdraw: (submissionId: number) => void;
	readonly listRef: RefObject<HTMLDivElement | null>;
	readonly onOpened: (element: Element) => void;
	readonly connection: string;
	readonly onFireHook: (hookId: string, payload: string | undefined) => void;
	readonly onToggleHook: (hookId: string, enabled: boolean) => void;
	readonly onToggleGenUi: (enabled: boolean) => void;
	readonly status: { hooks: { id: string; name: string; enabled: boolean; fireCount: number }[]; sandboxedUiEnabled: boolean } | undefined;
	readonly pending: boolean;
}

/** A ticking clock, only while something is counting down. */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

export function Transcript({
	view,
	busy,
	debug,
	bridgeFor,
	onWithdraw,
	listRef,
	onOpened,
	connection,
	onFireHook,
	onToggleHook,
	onToggleGenUi,
	status,
	pending,
}: TranscriptProps) {
	const entries = view?.entries ?? [];
	const live = liveOf(view);
	const blocks = useMemo(() => groupEntries(entries), [entries]);
	// While a turn runs its block is the live working block, not a settled one.
	const last = blocks[blocks.length - 1];
	const liveTurn = busy && last !== undefined && last.kind === "turn" ? last.turn : undefined;
	const settled = liveTurn === undefined ? blocks : blocks.slice(0, -1);
	const streaming = busy ? live?.generation?.message : undefined;
	const tools = live?.tools ?? [];
	const nested = live?.nestedTools ?? [];
	const pieces = useMemo(
		() => turnPieces(liveTurn, streaming, tools, { nested, widgetRows: debug }),
		[liveTurn, streaming, tools, nested, debug],
	);
	const queued = inboxOf(view)?.items ?? [];
	const usage = usageOf(view);
	const waiting = live?.generation?.retry !== undefined || live?.generation?.deferred !== undefined;
	const now = useNow(waiting);
	const empty = settled.length === 0 && !busy && queued.length === 0;
	const withdraw = useCallback((submissionId: number) => onWithdraw(submissionId), [onWithdraw]);

	return (
		<div
			id="transcript"
			className={empty ? "empty" : ""}
			ref={listRef}
			data-testid="transcript"
		>
			{empty ? (
				<p className="empty-hint" data-testid="transcript-empty">
					Send a message, or fire a hook and let the agent speak first.
				</p>
			) : null}
			{settled.map((block) => {
				if (block.kind === "user") return <UserRow key={blockKey(block)} entry={block.entry} />;
				if (block.kind === "hook") return <HookRow key={blockKey(block)} entry={block.entry} debug={debug} />;
				if (block.kind === "note") return <NoteRow key={blockKey(block)} entry={block.entry} debug={debug} />;
				return (
					<SettledTurn
						key={blockKey(block)}
						turn={block.turn}
						debug={debug}
						bridgeFor={bridgeFor}
						onOpened={onOpened}
						// Only the newest turn is worth retrying: once anything follows it — a message, or the
						// supervisor's own retry — the failure is history, not a dead end.
						onRetry={block === blocks[blocks.length - 1] ? (error) => onFireHook(RETRY_HOOK_ID, error) : undefined}
					/>
				);
			})}
			<div className="live">
				<div className="live-bubbles">
					<LiveChips live={live} busy={busy} debug={debug} now={now} />
					<LiveBubbles
						pieces={pieces}
						deferred={live?.generation?.deferred !== undefined}
						debug={debug}
						bridgeFor={bridgeFor}
						onOpened={onOpened}
					/>
				</div>
				<div className="live-queued">
					<QueuedRows items={queued} onWithdraw={withdraw} debug={debug} />
				</div>
			</div>
			{debug ? (
				<>
					<DebugSheet
						connection={connection}
						view={view}
						live={live}
						hooks={status?.hooks ?? []}
						sandboxedUiEnabled={status?.sandboxedUiEnabled ?? false}
						pending={pending}
						onFireHook={onFireHook}
						onToggleHook={onToggleHook}
						onToggleGenUi={onToggleGenUi}
					/>
					<UsagePanel usage={usage} />
				</>
			) : null}
		</div>
	);
}
