/**
 * The reader's rows: the transcript the server projected, plus the queue behind the running turn.
 *
 * Nothing here derives state from the machine. The server sends finished rows — a user's message, a sent message, a
 * widget, a trigger, a coarse notice — and this renders them in order. That is the whole client model, and it is why
 * reasoning, tool calls and tool output cannot appear on screen: they never arrive.
 */
import type { QueuedItem, TranscriptItem } from "../../shared/contract.ts";
import type { WidgetBridge } from "../lib/websandbox-loader.ts";
import { DeliveredRow, NoticeRow, UserRow, WorkingRow } from "./MessageRow.tsx";
import { QueuedRows } from "./QueuedRows.tsx";
import { WidgetCard } from "./WidgetCard.tsx";

export interface TranscriptProps {
	readonly transcript: readonly TranscriptItem[];
	readonly queued: readonly QueuedItem[];
	/** The line for a running turn; `undefined` when nothing runs, so it leaves no trace behind. */
	readonly working: string | undefined;
	readonly onWithdraw: (submissionId: number) => void;
	readonly bridgeFor: (callId: string) => WidgetBridge;
	readonly connection: string;
}

export function Transcript({ transcript, queued, working, onWithdraw, bridgeFor, connection }: TranscriptProps) {
	const empty = transcript.length === 0 && queued.length === 0;
	return (
		<div id="transcript" className={empty ? "empty" : ""} data-testid="transcript" data-connection={connection}>
			{empty ? (
				<p className="empty-hint" data-testid="transcript-empty">
					Send a message, or fire a hook and let the agent speak first.
				</p>
			) : null}
			{transcript.map((item) => {
				switch (item.kind) {
					case "user":
						return <UserRow key={item.id} text={item.text} />;
					case "delivered":
						return <DeliveredRow key={item.id} text={item.text} failed={item.failed === true} streaming={item.streaming === true} />;
					case "widget":
						return <WidgetCard key={item.id} callId={item.id} content={item.content} streaming={item.streaming} bridgeFor={bridgeFor} />;
					case "notice":
						return <NoticeRow key={item.id} text={item.text} />;
				}
			})}
			{working === undefined ? null : <WorkingRow label={working} />}
			<QueuedRows items={queued} onWithdraw={onWithdraw} />
		</div>
	);
}
