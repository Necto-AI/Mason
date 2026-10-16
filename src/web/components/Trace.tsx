/**
 * The working trace of one bubble: the thinking lines and tool rows behind a message, inside one `<details>`.
 *
 * Collapsed by default, live or settled: the block is a one-line answer to "what is it doing" — `Working · bash:
 * npm test` — and everything that would expand it (each thought, each call, each line of output) is the reader's
 * choice, one click away. Diagnostics mode opens it for whoever asked for the noise. Ported from sibling's
 * transcript trace with pi-durable's richer live state: running output, nested calls, diagnostics.
 */
import { useEffect, useRef, useState } from "react";
import { pairToolResults, type TracePiece } from "../lib/transcript-model.ts";
import { summarizeArgs } from "../lib/tool-view.ts";
import { textOf } from "../view-types.ts";
import { OrphanResult, ToolRow } from "./ToolRow.tsx";

/** The step the run is on, for the collapsed summary: one line, no expansion needed. */
function latestStep(pieces: readonly TracePiece[]): string | undefined {
	for (let index = pieces.length - 1; index >= 0; index -= 1) {
		const piece = pieces[index];
		if (piece === undefined) continue;
		if (piece.kind === "thinking") return "thinking";
		if (piece.kind === "toolCall") {
			const summary = summarizeArgs(piece.block.arguments);
			return summary === "" ? piece.block.name : `${piece.block.name}: ${summary}`;
		}
		if (piece.kind === "toolLive") return piece.tool.name;
	}
	return undefined;
}

export interface TraceProps {
	readonly pieces: readonly TracePiece[];
	/** `true` while the turn runs: the summary shows the spinner and says "Working" or "Waiting". */
	readonly live: boolean;
	readonly deferred?: boolean;
	readonly debug?: boolean;
	readonly onOpened: (element: Element) => void;
}

function ThinkingRow({
	text,
	open: initial,
	onOpened,
}: {
	text: string;
	open: boolean;
	onOpened: (element: Element) => void;
}) {
	const [open, setOpen] = useState(initial);
	const ref = useRef<HTMLDetailsElement | null>(null);
	useEffect(() => {
		if (ref.current !== null) onOpened(ref.current);
	}, [onOpened]);
	return (
		<details
			className="reason-row"
			ref={ref}
			open={open}
			onToggle={(event) => setOpen(event.currentTarget.open)}
			data-testid="thinking"
		>
			<summary>
				<span className="chev">{"\u203a"}</span>
				<span className="reason-label">thinking</span>
			</summary>
			<pre className="rbody">{text}</pre>
		</details>
	);
}

export function Trace({ pieces, live, deferred, debug, onOpened }: TraceProps) {
	// Compact by default: the summary carries the name of the current step, and the body is opened on demand.
	const [open, setOpen] = useState(debug === true);
	const ref = useRef<HTMLDetailsElement | null>(null);
	useEffect(() => {
		if (ref.current !== null) onOpened(ref.current);
	}, [onOpened]);

	const { byCall, orphans } = pairToolResults(pieces);
	const orphanIds = new Set(orphans.map((message) => message.toolCallId));
	const rows = pieces.map((piece) => {
		if (piece.kind === "thinking") {
			return <ThinkingRow key={piece.id} text={piece.text} open={debug === true} onOpened={onOpened} />;
		}
		if (piece.kind === "toolCall") {
			const result = byCall.get(piece.block.id);
			return (
				<ToolRow
					key={piece.id}
					name={piece.block.name}
					callId={piece.block.id}
					args={piece.block.arguments}
					status={piece.status}
					output={piece.slot?.output}
					droppedBytes={piece.slot?.droppedBytes}
					droppedLines={piece.slot?.droppedLines}
					result={result === undefined ? undefined : textOf(result)}
					isError={result?.isError}
					durationMs={result?.durationMs}
					slot={piece.slot}
					diagnostics={piece.slot?.diagnostics}
					nested={piece.nested}
					debug={debug}
					onOpened={onOpened}
				/>
			);
		}
		if (piece.kind === "toolLive") {
			return (
				<ToolRow
					key={piece.id}
					name={piece.tool.name}
					callId={piece.tool.callId}
					status={piece.status}
					output={piece.tool.output}
					droppedBytes={piece.tool.droppedBytes}
					droppedLines={piece.tool.droppedLines}
					slot={piece.tool}
					diagnostics={piece.tool.diagnostics}
					nested={piece.nested}
					debug={debug}
					onOpened={onOpened}
				/>
			);
		}
		// A result whose call is not in this trace (a compaction dropped it) needs its own panel; the rest are
		// merged into their call's row.
		if (!orphanIds.has(piece.message.toolCallId)) return null;
		return <OrphanResult key={piece.id} text={textOf(piece.message)} isError={piece.message.isError === true} />;
	});

	// A live bubble shows its summary before the first piece lands, so the run reads as working.
	if (!live && pieces.length === 0) return null;
	const step = live ? latestStep(pieces) : undefined;

	return (
		<details
			className={`trace${live ? " live" : " settled"}`}
			ref={ref}
			open={open}
			onToggle={(event) => setOpen(event.currentTarget.open)}
			data-testid="trace"
			data-live={live}
		>
			<summary>
				{live ? (deferred === true ? "Waiting" : "Working") : "Work"}
				{step === undefined ? null : <span className="trace-step">{step}</span>}
				{live ? <span className="jump-ring" /> : null}
			</summary>
			<div className="trace-body">{rows}</div>
		</details>
	);
}
