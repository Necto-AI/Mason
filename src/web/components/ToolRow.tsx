/**
 * Tool rows, in sibling's shape: the glyph, `name:`, a one-line summary, the duration on hover and a quiet state
 * glyph, opening into the arguments and the result. A running call also shows the output it has reported so far.
 * Debug mode adds what the durable backend knows and the normal view hides.
 */
import { useEffect, useRef, useState } from "react";
import { iconFor, pretty, stateIconFor, stepDuration, summarizeArgs, SVG_ATTRS } from "../lib/tool-view.ts";
import type { ToolStatus } from "../lib/transcript-model.ts";
import type { NestedToolSlotLike, ToolDiagnosticLike, ToolSlotLike } from "../view-types.ts";

/** Output longer than this collapses behind a "show all" line. */
const LIVE_LINES = 12;

export interface ToolRowProps {
	readonly name: string;
	readonly callId?: string;
	readonly args?: unknown;
	readonly status: ToolStatus;
	/** Retained output of a running (or settled) call. */
	readonly output?: string;
	readonly droppedBytes?: number;
	readonly droppedLines?: number;
	/** The settled result, when there is one. */
	readonly result?: string;
	readonly isError?: boolean;
	readonly durationMs?: number;
	/** The live slot, in debug mode. */
	readonly slot?: ToolSlotLike;
	readonly diagnostics?: readonly ToolDiagnosticLike[];
	readonly nested?: readonly NestedToolSlotLike[];
	readonly debug?: boolean;
	readonly byTaskId?: number;
	/** Records a `<details>` the view opened itself, so its toggle is not read as reader intent. */
	readonly onOpened?: (element: Element) => void;
}

function Glyph({ name }: { name: string }) {
	return (
		<span className="step-icon" dangerouslySetInnerHTML={{ __html: `<svg ${SVG_ATTRS}>${iconFor(name)}</svg>` }} />
	);
}

function StateGlyph({ status }: { status: ToolStatus }) {
	const path = stateIconFor(status);
	if (status === "running") {
		return (
			<span className="step-state">
				<span className="step-spin" />
			</span>
		);
	}
	if (path === undefined) return <span className="step-state" />;
	return <span className="step-state" dangerouslySetInnerHTML={{ __html: `<svg ${SVG_ATTRS}>${path}</svg>` }} />;
}

/** The live output of a running call: the last lines, with the rest behind one click. */
function LiveOutput({
	output,
	droppedBytes,
	droppedLines,
}: {
	output: string;
	droppedBytes?: number;
	droppedLines?: number;
}) {
	const [all, setAll] = useState(false);
	const lines = output.split("\n");
	const shown = all || lines.length <= LIVE_LINES ? output : lines.slice(-LIVE_LINES).join("\n");
	const dropped = (droppedLines ?? 0) > 0 || (droppedBytes ?? 0) > 0;
	return (
		<>
			<pre className="step-block live" data-testid="tool-live-output">
				{shown.trimEnd()}
			</pre>
			{lines.length > LIVE_LINES || dropped ? (
				<div className="step-more">
					<button type="button" className="step-toggle" onClick={() => setAll((value) => !value)}>
						{all ? "show less" : `show all${dropped ? " (older output dropped)" : ""}`}
					</button>
				</div>
			) : null}
		</>
	);
}

function DebugFacts({
	callId,
	slot,
	diagnostics,
	byTaskId,
}: {
	callId?: string;
	slot?: ToolSlotLike;
	diagnostics?: readonly ToolDiagnosticLike[];
	byTaskId?: number;
}) {
	const facts: string[] = [];
	if (callId !== undefined && callId !== "") facts.push(`callId=${callId}`);
	if (slot?.taskId !== undefined) facts.push(`taskId=${slot.taskId}`);
	if (slot?.entry !== undefined) facts.push(`entry=${slot.entry}`);
	if (byTaskId !== undefined) facts.push(`byTaskId=${byTaskId}`);
	if (slot?.status !== undefined) facts.push(`slot=${slot.status}`);
	if (slot?.droppedBytes !== undefined) facts.push(`droppedBytes=${slot.droppedBytes}`);
	if (slot?.droppedLines !== undefined) facts.push(`droppedLines=${slot.droppedLines}`);
	if (facts.length === 0 && slot?.details === undefined && (diagnostics ?? []).length === 0) return null;
	return (
		<div className="debug-facts">
			{facts.length === 0 ? null : <code>{facts.join(" ")}</code>}
			{slot?.details === undefined ? null : <pre className="step-block details">{pretty(slot.details)}</pre>}
			{(diagnostics ?? []).map((diagnostic, index) => (
				<div className="debug-diagnostic" key={index}>
					{`${diagnostic.severity}: ${diagnostic.message}${diagnostic.code === undefined ? "" : ` (${diagnostic.code})`}`}
				</div>
			))}
		</div>
	);
}

/** Nested calls of a running tool: sub-rows under their parent. */
function NestedRows({ nested, debug }: { nested: readonly NestedToolSlotLike[]; debug?: boolean }) {
	if (nested.length === 0) return null;
	return (
		<div className="nested" data-testid="nested-tools">
			{nested.map((child) => (
				<ToolRow
					key={child.callId}
					name={child.name}
					callId={child.callId}
					args={child.arguments}
					status={child.status === "done" ? (child.summary?.isError === true ? "error" : "done") : child.status}
					output={child.status === "running" ? child.output : undefined}
					droppedBytes={child.droppedBytes}
					droppedLines={child.droppedLines}
					result={child.status === "done" ? child.output : undefined}
					durationMs={child.summary?.durationMs}
					diagnostics={child.diagnostics}
					debug={debug}
				/>
			))}
		</div>
	);
}

export function ToolRow({
	name,
	callId,
	args,
	status,
	output,
	droppedBytes,
	droppedLines,
	result,
	isError,
	durationMs,
	slot,
	diagnostics,
	nested = [],
	debug,
	byTaskId,
	onOpened,
}: ToolRowProps) {
	const openByDefault = status === "running" || status === "pending";
	const [open, setOpen] = useState(openByDefault);
	const ref = useRef<HTMLDetailsElement | null>(null);
	useEffect(() => {
		if (open && ref.current !== null) onOpened?.(ref.current);
	}, [open, onOpened]);
	const summary = summarizeArgs(args);
	const durationLabel = durationMs === undefined ? undefined : stepDuration(durationMs);
	const failed = status === "error";
	const running = status === "running" || status === "pending";
	const settled = result === undefined || result.trim() === "" ? undefined : result;
	return (
		<details
			className={`step tool${status === "running" ? " running" : ""}${failed ? " error" : ""}`}
			ref={ref}
			open={open}
			onToggle={(event) => setOpen(event.currentTarget.open)}
			data-testid={`tool-${name}`}
			data-status={status}
		>
			<summary>
				<Glyph name={name} />
				<span className="step-name">{name}</span>
				<span className="step-text">{summary === "" ? "\u2026" : summary}</span>
				<span className="step-dur">{durationLabel ?? ""}</span>
				<StateGlyph status={status} />
			</summary>
			{args === undefined ? null : <pre className="step-block args">{pretty(args)}</pre>}
			{running && output !== undefined && output !== "" ? (
				<LiveOutput output={output} droppedBytes={droppedBytes} droppedLines={droppedLines} />
			) : null}
			{settled === undefined ? null : !running && output !== undefined && result === undefined ? (
				<pre className="step-block result">{output.trimEnd()}</pre>
			) : (
				<pre className={`step-block result${failed || isError === true ? " error" : ""}`} data-testid="tool-result">
					{settled.trimEnd()}
				</pre>
			)}
			{debug === true ? <DebugFacts callId={callId} slot={slot} diagnostics={diagnostics} byTaskId={byTaskId} /> : null}
			<NestedRows nested={nested} debug={debug} />
		</details>
	);
}

/** A settled result whose call is gone (a compaction dropped it): its own quiet panel. */
export function OrphanResult({ text, isError }: { text: string; isError: boolean }) {
	return (
		<article className={`message toolResult${isError ? " error" : ""}`}>
			<div className="tool-label">{isError ? "tool error" : "tool result"}</div>
			<pre className="step-block result">{text.trim() || "(no output)"}</pre>
		</article>
	);
}
