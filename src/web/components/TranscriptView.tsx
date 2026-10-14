/**
 * The transcript: committed entries plus, while a turn runs, the message the model is still writing.
 * Every message carries a badge saying whether it is settled or streaming, and tool calls show their status.
 */
import { useEffect, useMemo, useRef } from "react";
import { contentFromToolCall } from "../lib/open-genui-content.ts";
import type { WidgetBridge } from "../lib/websandbox-loader.ts";
import { SandboxedUiCard } from "./SandboxedUiCard.tsx";
import { ToolRow } from "./ToolRow.tsx";
import {
	hookData,
	live as liveOf,
	textOf,
	thinkingOf,
	toolCallsOf,
	type ConversationViewLike,
	type EntryLike,
	type JsonObject,
	type LiveStateLike,
	type MessageLike,
	type ToolResultMessageLike,
	type ToolSlotLike,
} from "../view-types.ts";

export interface TranscriptViewProps {
	readonly view: ConversationViewLike | undefined;
	readonly bridgeFor: (callId: string) => WidgetBridge;
}

interface ToolResultInfo {
	text: string;
	isError: boolean;
	durationMs?: number;
}

function toolResults(entries: EntryLike[]): Map<string, ToolResultInfo> {
	const map = new Map<string, ToolResultInfo>();
	for (const entry of entries) {
		if (entry.kind !== "pi.tool-result") continue;
		for (const message of entry.model ?? []) {
			const result = message as ToolResultMessageLike;
			if (result.role !== "toolResult") continue;
			map.set(result.toolCallId, {
				text: textOf(result),
				isError: result.isError === true,
				durationMs: result.durationMs,
			});
		}
	}
	return map;
}

function summarise(data: JsonObject | undefined): string {
	if (data === undefined) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (typeof value === "string" || typeof value === "number") parts.push(`${key}=${value}`);
	}
	return parts.join(" ");
}

/** Running slots whose call is not already on screen (its assistant entry is gone after a compaction). */
function LiveTools({ live, visible, bridgeFor }: { live: LiveStateLike | undefined; visible: Set<string>; bridgeFor: (id: string) => WidgetBridge }) {
	const orphaned = (live?.tools ?? []).filter((slot) => slot.status === "running" && !visible.has(slot.callId));
	if (orphaned.length === 0) return null;
	return (
		<>
			{orphaned.map((slot) => (
				<ToolRow key={slot.callId} name={slot.name} callId={slot.callId} status={slot.status} output={slot.output} />
			))}
		</>
	);
}

function AssistantContent({
	message,
	settled,
	results,
	slots,
	bridgeFor,
}: {
	message: MessageLike | undefined;
	settled: boolean;
	results: Map<string, ToolResultInfo>;
	slots: Map<string, ToolSlotLike>;
	bridgeFor: (id: string) => WidgetBridge;
}) {
	const text = textOf(message);
	const thinking = thinkingOf(message);
	const calls = toolCallsOf(message);
	return (
		<>
			{thinking === "" ? null : (
				<details className="thinking">
					<summary>thinking</summary>
					<pre>{thinking}</pre>
				</details>
			)}
			{text === "" ? null : <div className="bubble-text">{text}</div>}
			{calls.map((call) => {
				const result = results.get(call.id);
				const slot = slots.get(call.id);
				// The live slot knows `pending` vs `running`; a settled result overrides everything.
				const status: "pending" | "running" | "done" | "error" = result !== undefined
					? result.isError
						? "error"
						: "done"
					: (slot?.status ?? (settled ? "done" : "pending"));
				const widget =
					call.name === "generateSandboxedUi" && result?.isError !== true ? (
						<SandboxedUiCard
							content={contentFromToolCall(call.arguments, settled)}
							bridge={bridgeFor(call.id)}
							streaming={!settled}
						/>
					) : null;
				return (
					<ToolRow
						key={call.id}
						name={call.name}
						callId={call.id}
						arguments={call.arguments}
						status={status}
						output={slot?.output}
						result={result?.text}
						durationMs={result?.durationMs}
					>
						{widget}
					</ToolRow>
				);
			})}
		</>
	);
}

export function TranscriptView({ view, bridgeFor }: TranscriptViewProps) {
	const entries = view?.entries ?? [];
	const live = liveOf(view);
	const results = useMemo(() => toolResults(entries), [entries]);
	const slots = useMemo(() => {
		const map = new Map<string, ToolSlotLike>();
		for (const slot of liveOf(view)?.tools ?? []) map.set(slot.callId, slot);
		return map;
	}, [view]);
	const streaming = live?.generation?.message;
	// Every call the transcript already shows, so a running slot is never rendered twice.
	const visible = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of entries) for (const call of toolCallsOf(entry.model?.[0])) ids.add(call.id);
		for (const call of toolCallsOf(streaming)) ids.add(call.id);
		return ids;
	}, [entries, streaming]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const signal = `${entries.length}:${streaming === undefined ? 0 : textOf(streaming).length}`;

	useEffect(() => {
		const node = scrollRef.current;
		if (node === null || !pinned.current) return;
		node.scrollTop = node.scrollHeight;
	}, [signal]);

	return (
		<div
			className="transcript"
			data-testid="transcript"
			ref={scrollRef}
			onScroll={(event) => {
				const node = event.currentTarget;
				pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
			}}
		>
			{entries.length === 0 && streaming === undefined ? (
				<p className="empty" data-testid="transcript-empty">
					No conversation yet. Send a message, or fire a hook and let the agent speak first.
				</p>
			) : null}
			{entries.map((entry) => {
				if (entry.kind === "pi.user") {
					const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
					const text = typeof content === "string" ? content : textOf(entry.model?.[0]);
					return (
						<div className="row row-user" data-testid="msg-user" key={entry.id}>
							<span className="badge badge-settled">[USER • settled]</span>
							<div className="bubble bubble-user">{text}</div>
						</div>
					);
				}
				if (entry.kind === "app.hook") {
					const hook = hookData(entry);
					const prompt = textOf(entry.model?.[0]);
					// The prompt repeats its own `[EVENT HOOK: <name>]` header; the badge above already says that.
					const withoutHeader = prompt.replace(/^\[EVENT HOOK:[^\]]*\]\s*/, "");
					return (
						<div className="row row-hook" data-testid="msg-hook" key={entry.id}>
							<span className="badge badge-hook">{`[PROACTIVE HOOK: ${hook.hookName}${
								hook.firedAt === "" ? "" : ` • ${hook.firedAt}`
							}]`}</span>
							<div className="bubble bubble-hook">{withoutHeader}</div>
						</div>
					);
				}
				if (entry.kind === "pi.assistant") {
					const message = entry.model?.[0];
					const stop = (message as { stopReason?: string } | undefined)?.stopReason;
					return (
						<div className="row row-assistant" data-testid="msg-assistant" key={entry.id}>
							<span
								className={`badge ${stop === "error" || stop === "aborted" ? "badge-error" : "badge-settled"}`}
							>{`[ASSISTANT • settled • stopReason=${stop ?? "unknown"}]`}</span>
							<div className="bubble bubble-assistant">
								<AssistantContent message={message} settled results={results} slots={slots} bridgeFor={bridgeFor} />
							</div>
						</div>
					);
				}
				if (entry.kind === "pi.tool-result") return null;
				if (entry.kind === "pi.system") {
					const sections = (entry.model?.[0] as { sections?: Record<string, string | null> } | undefined)?.sections;
					const names = Object.keys(sections ?? {});
					return (
						<div className="row row-note" data-testid="entry-system" key={entry.id}>
							<span className="badge badge-note">{`[SYSTEM PROMPT • ${names.join(", ") || "updated"}]`}</span>
						</div>
					);
				}
				return (
					<div className="row row-note" data-testid={`entry-${entry.kind}`} key={entry.id}>
						<span className="badge badge-note">{`[${entry.kind.toUpperCase()} • ${summarise(entry.data)}]`}</span>
					</div>
				);
			})}
			{live?.compactionFailure === undefined ? null : (
				<div className="row row-note" data-testid="compaction-failure">
					<span className="badge badge-error">{`[COMPACTION FAILED • ${live.compactionFailure.error}]`}</span>
				</div>
			)}
			{streaming === undefined ? (
				<LiveTools live={live} visible={visible} bridgeFor={bridgeFor} />
			) : (
				<div className="row row-assistant" data-testid="streaming" key="streaming">
					<span className="badge badge-live">{`[ASSISTANT • STREAMING (attempt ${
						live?.generation?.attempt ?? 1
					})]`}</span>
					<div className="bubble bubble-assistant">
						<AssistantContent message={streaming} settled={false} results={results} slots={slots} bridgeFor={bridgeFor} />
					</div>
					{live?.generation?.retry === undefined ? null : (
						<span className="badge badge-error" data-testid="retry">{`[RETRY • ${live.generation.retry.at}]`}</span>
					)}
				</div>
			)}
		</div>
	);
}
