/**
 * The message-level rows of the transcript: the user's bubbles, the hook banner, system notes and the assistant
 * turn — settled (bubbles only, traces dropped) or live (one article per bubble, traces folding away).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown.ts";
import { StreamText } from "../lib/stream-text.tsx";
import {
	bubbleContent,
	bubbleHasContent,
	groupBubbles,
	type Bubble,
	type Piece,
	type Turn,
	turnErrors,
	turnPieces,
} from "../lib/transcript-model.ts";
import type { WidgetBridge } from "../lib/websandbox-loader.ts";
import { entryMessage, hookData, textOf, type EntryLike, type MessageLike } from "../view-types.ts";
import { Trace } from "./Trace.tsx";
import { WidgetCard } from "./WidgetCard.tsx";

const EASE = "cubic-bezier(0.2, 0, 0, 1)";
const COLLAPSE_MS = 140;

export interface OpenTracker {
	(element: Element): void;
}

/* ---------- user, hook, note ---------- */

export function UserRow({ entry }: { entry: EntryLike }) {
	return (
		<article className="message user" data-testid="msg-user">
			<div className="bubble">{textOf(entryMessage(entry))}</div>
		</article>
	);
}

/** `2026-10-14T09:12:31.004Z` reads better as `09:12`. */
function clockOf(firedAt: string): string {
	const at = new Date(firedAt);
	if (Number.isNaN(at.getTime())) return firedAt;
	return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A hook trigger: the agent woke on its own, and this is what woke it. */
export function HookRow({ entry, debug }: { entry: EntryLike; debug: boolean }) {
	const hook = hookData(entry);
	return (
		<article className="message hook" data-testid="msg-hook">
			<div className="bubble">
				<div className="hook-head">
					<span className="hook-mark" aria-hidden="true">
						{"\u25c6"}
					</span>
					<span className="hook-name">{`triggered ${hook.hookName}`}</span>
					{hook.firedAt === "" ? null : <span className="hook-when">{clockOf(hook.firedAt)}</span>}
				</div>
				{hook.payload === null ? null : <pre className="step-block payload">{hook.payload}</pre>}
				{debug ? (
					<div className="debug-facts">
						<code>{`hookId=${hook.hookId}`}</code>
						<pre className="step-block">{textOf(entryMessage(entry))}</pre>
					</div>
				) : null}
			</div>
		</article>
	);
}

/** A compaction, a reset, or a kind this client does not know: a quiet line in the flow. */
export function NoteRow({ entry, debug }: { entry: EntryLike; debug: boolean }) {
	const label =
		entry.kind === "pi.compaction" ? "compacted" : entry.kind === "pi.reset" ? "session reset" : entry.kind;
	// A compaction's summary is what the transcript shows; a reset's handoff text is a debug detail.
	const body = entry.kind === "pi.reset" && !debug ? "" : textOf(entryMessage(entry)).trim();
	const reason = (entry.data as { reason?: string } | undefined)?.reason;
	const [open, setOpen] = useState(false);
	if (body === "" && !debug) return <div className="note" data-testid={`entry-${entry.kind}`}>{label}</div>;
	return (
		<details
			className="note"
			data-testid={`entry-${entry.kind}`}
			open={open}
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary>{label}</summary>
			{body === "" ? null : <pre className="step-block">{body}</pre>}
			{debug ? (
				<div className="debug-facts">
					<code>{`entryId=${entry.id}${reason === undefined ? "" : ` reason=${reason}`}${
						entry.byTaskId === undefined ? "" : ` byTaskId=${entry.byTaskId}`
					}`}</code>
				</div>
			) : null}
		</details>
	);
}

/* ---------- assistant ---------- */

function MarkdownText({ text }: { text: string }) {
	const html = useMemo(() => renderMarkdown(text), [text]);
	return <div className="text markdown" data-testid="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * A bubble's content, split: text stays in the bubble, widgets render as their own full-width blocks beside it.
 * Inside the bubble a card could only ever be as wide as the sentence that introduced it.
 */
function bubbleParts(bubble: Bubble) {
	const items = bubbleContent(bubble);
	return {
		text: items.filter((item) => item.kind === "text"),
		widgets: items.filter((item) => item.kind === "widget"),
	};
}

interface BubbleProps {
	readonly bubble: Bubble;
	readonly debug: boolean;
	readonly bridgeFor: (callId: string) => WidgetBridge;
	readonly onOpened: OpenTracker;
}

/** One bubble of a settled turn: its text and its widgets; the trace only survives in debug mode. */
function SettledBubble({ bubble, debug, bridgeFor, onOpened }: BubbleProps) {
	const { text, widgets } = bubbleParts(bubble);
	return (
		<>
			{debug || text.length > 0 ? (
				<div className="bubble">
					{debug ? <Trace pieces={bubble.trace} live={false} debug onOpened={onOpened} /> : null}
					{text.map((content) => (
						<MarkdownText key={content.key} text={content.text} />
					))}
				</div>
			) : null}
			{widgets.map((content) => (
				<div className="bubble-widgets" key={content.key}>
					<WidgetCard piece={content.piece} bridgeFor={bridgeFor} debug={debug} />
				</div>
			))}
		</>
	);
}

/** One bubble of the running turn: the trace folds away the moment the bubble produced something. */
function LiveBubble({
	bubble,
	deferred,
	debug,
	bridgeFor,
	onOpened,
}: BubbleProps & { deferred: boolean }) {
	const produced = bubbleHasContent(bubble);
	const wrap = useRef<HTMLDivElement | null>(null);
	// A bubble that mounts already produced (a reconnect) never shows the trace at all.
	const [dropped, setDropped] = useState(produced);

	useEffect(() => {
		// Debug keeps the work visible, including the row of a widget call above its card.
		if (!produced || dropped || debug) return;
		const node = wrap.current;
		if (node === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			setDropped(true);
			return;
		}
		const height = node.offsetHeight;
		node.style.overflow = "hidden";
		const animation = node.animate(
			[
				{ height: `${height}px`, opacity: 1 },
				{ height: "0px", opacity: 0 },
			],
			{ duration: COLLAPSE_MS, easing: EASE },
		);
		animation.onfinish = () => setDropped(true);
		animation.oncancel = () => setDropped(true);
	}, [produced, dropped, debug]);

	const showTrace = debug || !dropped;
	const { text, widgets } = bubbleParts(bubble);
	const showBubble = showTrace || text.length > 0;
	return (
		<>
			{showBubble ? (
				<div className="bubble">
					{showTrace ? (
						<div className="trace-slot" ref={wrap}>
							<Trace pieces={bubble.trace} live deferred={deferred} debug={debug} onOpened={onOpened} />
						</div>
					) : null}
					{text.map((content) => (
						<StreamText key={content.key} text={content.text} />
					))}
				</div>
			) : null}
			{widgets.map((content) => (
				<div className="bubble-widgets" key={content.key}>
					<WidgetCard piece={content.piece} bridgeFor={bridgeFor} debug={debug} />
				</div>
			))}
		</>
	);
}

/** A settled turn: the bubbles the model produced, in order; errors read as notes after them. */
export function SettledTurn({
	turn,
	debug,
	bridgeFor,
	onOpened,
	onRetry,
}: {
	turn: Turn;
	debug: boolean;
	bridgeFor: (callId: string) => WidgetBridge;
	onOpened: OpenTracker;
	/** Fires `retry-failed-run` with the failure text when the reader asks for the run again. */
	onRetry?: (error: string) => void;
}) {
	const bubbles = groupBubbles(turnPieces(turn, undefined, [], { widgetRows: debug })).filter(bubbleHasContent);
	const errors = turnErrors(turn);
	if (bubbles.length === 0 && errors.length === 0) return null;
	return (
		<article className="message assistant" data-testid="msg-assistant">
			{bubbles.map((bubble) => (
				<SettledBubble key={bubble.key} bubble={bubble} debug={debug} bridgeFor={bridgeFor} onOpened={onOpened} />
			))}
			{errors.length === 0 ? null : (
				// A failed run is a dead end otherwise: durable keeps the conversation, so the way out is to ask
				// again with the failure in hand — as a hook event, not a message the user never wrote.
				<div className="note error-note" data-testid="run-error">
					{errors.map((error) => (
						<div className="error-line" key={error}>
							{error}
						</div>
					))}
					{onRetry === undefined ? null : (
						<button
							type="button"
							className="retry-run"
							data-testid="retry-run"
							onClick={() => onRetry(errors.join("\n"))}
						>
							Retry
						</button>
					)}
				</div>
			)}
			{debug ? <SettledDebug turn={turn} /> : null}
		</article>
	);
}

/** The running turn: one article per bubble, so a trace can fold without touching the rest. */
export function LiveBubbles({
	pieces,
	deferred,
	debug,
	bridgeFor,
	onOpened,
}: {
	pieces: readonly Piece[];
	deferred: boolean;
	debug: boolean;
	bridgeFor: (callId: string) => WidgetBridge;
	onOpened: OpenTracker;
}) {
	const bubbles = groupBubbles(pieces);
	return (
		<>
			{bubbles.map((bubble) => (
				<article className="message assistant streaming" key={bubble.key} data-testid="msg-live">
					<LiveBubble bubble={bubble} deferred={deferred} debug={debug} bridgeFor={bridgeFor} onOpened={onOpened} />
				</article>
			))}
		</>
	);
}

/** Debug: what each answer of the turn reported, and the positional prompt entries between them. */
function SettledDebug({ turn }: { turn: Turn }) {
	return (
		<div className="debug-facts" data-testid="turn-debug">
			{turn.entries.map((entry) => {
				const message = entryMessage(entry) as MessageLike | undefined;
				if (entry.kind === "pi.system") {
					const sections = (message as { sections?: Record<string, string | null> } | undefined)?.sections ?? {};
					const added = (message as { toolsAdded?: { name: string }[] } | undefined)?.toolsAdded ?? [];
					const removed = (message as { toolsRemoved?: { name: string }[] } | undefined)?.toolsRemoved ?? [];
					return (
						<div className="debug-line" key={entry.id} data-testid="entry-system">
							<code>{`[system • sections: ${Object.keys(sections).join(", ") || "none"}${
								added.length === 0 ? "" : ` • +${added.map((tool) => tool.name).join(",")}`
							}${removed.length === 0 ? "" : ` • -${removed.map((tool) => tool.name).join(",")}`}]`}</code>
						</div>
					);
				}
				if (entry.kind === "pi.assistant") {
					const info = message as
						| { stopReason?: string; attempt?: number; durationMs?: number; usage?: { totalTokens: number; cost: { total: number } } }
						| undefined;
					const parts = [
						"assistant",
						`stopReason=${info?.stopReason ?? "unknown"}`,
						entry.byTaskId === undefined ? undefined : `byTaskId=${entry.byTaskId}`,
						info?.durationMs === undefined ? undefined : `durationMs=${info.durationMs}`,
						info?.usage === undefined ? undefined : `tokens=${info.usage.totalTokens}`,
						info?.usage === undefined ? undefined : `cost=$${info.usage.cost.total.toFixed(4)}`,
					].filter((part): part is string => part !== undefined);
					return (
						<div className="debug-line" key={entry.id} data-testid="entry-assistant">
							<code>{`[${parts.join(" • ")}]`}</code>
						</div>
					);
				}
				return null;
			})}
		</div>
	);
}
