/**
 * The raw Trace: the durable entries themselves, for the device the operator granted `trace`.
 *
 * The projection is a whitelist and this is what it leaves out — the model messages, the tool calls and their results,
 * a hook's payload, the permission questions, the deliveries, the chat commands, and the context edits and compaction
 * entries that changed what the model is asked next. The server sends the entries as stored (`src/server/trace.ts`);
 * this page only chooses how to read them, and the JSON stays one click away for everything the summary does not say.
 */
import { useState } from "react";
import type { Trace, TraceEntry } from "../../../shared/admin.ts";
import { Badge, Card } from "../ui.tsx";

/** The kinds the trace is usually read for, in the order the panel offers them. */
const KIND_TONES: Record<string, string> = {
	"pi.user": "said the words",
	"pi.assistant": "wrote a message",
	"pi.tool-result": "returned a tool",
	"pi.compaction": "changed the context",
	"app.reply": "sent a reply",
	"app.delivery": "acknowledged a delivery",
	"app.permission": "asked a question",
	"app.permission-answer": "answered a question",
	"app.hook": "fired a hook",
	"app.connector": "carried a person's words",
	"app.command": "ran a command",
};

function textOf(blocks: readonly unknown[]): string {
	return blocks
		.map((part) => {
			const block = part as { type?: string; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter((text) => text !== "")
		.join("\n");
}

/** One stored message: its role, its words, and the calls or results it carried. */
function Message({ message }: { readonly message: unknown }) {
	const raw = message as {
		role?: unknown;
		content?: unknown;
		toolName?: unknown;
		isError?: unknown;
		stopReason?: unknown;
	};
	const role = typeof raw.role === "string" ? raw.role : "message";
	const blocks = Array.isArray(raw.content) ? raw.content : [];
	const calls = blocks.filter((part) => (part as { type?: string }).type === "toolCall");
	const results = blocks.filter((part) => (part as { type?: string }).type === "toolResult");
	// A connector's words are stored as a string and a model's as blocks; both are the message.
	const text = typeof raw.content === "string" ? raw.content : textOf(blocks);
	return (
		<div className="trace-message">
			<div className="trace-message-head">
				<Badge tone={role === "assistant" ? "accent" : "muted"}>{role}</Badge>
				{typeof raw.toolName === "string" ? <span className="mono faint">{raw.toolName}</span> : null}
				{raw.isError === true ? <Badge tone="error">error</Badge> : null}
				{typeof raw.stopReason === "string" ? <span className="faint">{raw.stopReason}</span> : null}
			</div>
			{text === "" ? null : <pre className="trace-text">{text}</pre>}
			{calls.map((part, index) => {
				const call = part as { id?: unknown; name?: unknown; arguments?: unknown };
				return (
					<pre className="trace-call" key={`${String(call.id)}-${index}`}>
						{`${typeof call.name === "string" ? call.name : "call"}(${JSON.stringify(call.arguments ?? {})})`}
					</pre>
				);
			})}
			{results.map((part, index) => {
				const result = part as { toolName?: unknown; content?: unknown };
				const blocksOut = Array.isArray(result.content) ? result.content : [];
				return (
					<pre className="trace-call" key={`${String(result.toolName)}-${index}`}>
						{`${typeof result.toolName === "string" ? result.toolName : "result"} → ${textOf(blocksOut)}`}
					</pre>
				);
			})}
		</div>
	);
}

function Entry({ entry }: { readonly entry: TraceEntry }) {
	const messages = entry.model ?? [];
	return (
		<details className="trace-entry">
			<summary>
				<span className="mono faint">{entry.id}</span>
				<span className="trace-kind">{entry.kind}</span>
				<span className="trace-explain">{KIND_TONES[entry.kind] ?? ""}</span>
				{messages.length === 0 ? null : <span className="faint">{messages.length} msg</span>}
			</summary>
			{/* A stored message has no id of its own: the entry's id and the message's position are its identity. */}
			{messages.map((message, index) => (
				<Message key={`${entry.id}-${index}`} message={message} />
			))}
			{entry.data === undefined ? null : <pre className="trace-data">{JSON.stringify(entry.data, null, 2)}</pre>}
			{entry.head === undefined ? null : <p className="trace-note">moved the active context to {entry.head}</p>}
			{entry.edits === undefined ? null : <pre className="trace-data">{JSON.stringify(entry.edits, null, 2)}</pre>}
			{entry.byTaskId === undefined ? null : <p className="trace-note">written by task {entry.byTaskId}</p>}
		</details>
	);
}

export function TraceView({ trace }: { readonly trace: Trace }) {
	const [kind, setKind] = useState<string | undefined>(undefined);
	const entries = kind === undefined ? trace.entries : trace.entries.filter((entry) => entry.kind === kind);
	return (
		<Card
			title="Trace"
			note="The durable entries, as stored: model messages, tool calls and results, hook payloads, questions, deliveries and context changes."
			actions={
				<>
					<Badge tone="muted">{trace.entries.length} entries</Badge>
					<Badge tone="muted">{trace.conversationId}</Badge>
				</>
			}
		>
			<div className="kinds">
				<button
					type="button"
					className={`chip${kind === undefined ? " on" : ""}`}
					onClick={() => setKind(undefined)}
				>
					all
				</button>
				{trace.kinds.map((entry) => (
					<button
						type="button"
						key={entry.kind}
						className={`chip${kind === entry.kind ? " on" : ""}`}
						onClick={() => setKind(kind === entry.kind ? undefined : entry.kind)}
					>
						{entry.kind} <span className="faint">{entry.count}</span>
					</button>
				))}
			</div>
			{entries.length === 0 ? (
				<p className="empty">No entries of this kind.</p>
			) : (
				<div className="trace">
					{entries.map((entry) => (
						<Entry key={entry.id} entry={entry} />
					))}
				</div>
			)}
		</Card>
	);
}
