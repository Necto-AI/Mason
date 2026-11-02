/**
 * The complete projected Conversation, across every connector, read by an operator.
 *
 * This is the same whitelist the reader had (`src/server/projection.ts`), rendered in the panel rather than in a chat:
 * a person's words with the name the server wrote, the messages the agent sent, widgets, and one coarse notice when a
 * turn died. There is nothing to type into: the panel is a control plane, not a second conversational client (#103), so
 * the only controls are the two that belong to an operator — stop the turn that is running, and compact the context.
 */
import type { AgentStatus, QueuedItem, TranscriptItem } from "../../../shared/contract.ts";
import { WidgetCard } from "../../components/WidgetCard.tsx";
import { renderMarkdown } from "../../lib/markdown.ts";
import type { WidgetBridge } from "../../lib/websandbox-loader.ts";
import { Badge, Card, ErrorNote, useAction } from "../ui.tsx";

export interface ConversationArea {
	readonly status: AgentStatus;
	readonly transcript: readonly TranscriptItem[];
	readonly queued: readonly QueuedItem[];
}

/**
 * A widget shown here is shown to be inspected, not used: a prompt sent from inside one has no reader to arrive at, so
 * the panel says so rather than dropping the click on the floor.
 */
const BRIDGE: WidgetBridge = {
	sendPrompt: async () => ({ delivered: false, reason: "the operator panel does not send messages" }),
	openLink: async ({ url }) => {
		if (/^https?:\/\//.test(url)) window.open(url, "_blank", "noopener");
		return { opened: true };
	},
};

function Row({ item }: { readonly item: TranscriptItem }) {
	if (item.kind === "user") {
		return (
			<div className="said said-user" data-testid="said-user">
				<span className="said-who">{item.author ?? "unnamed"}</span>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: `renderMarkdown` is the shared renderer, and it drops raw HTML */}
				<div className="said-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
			</div>
		);
	}
	if (item.kind === "delivered") {
		return (
			<div className="said said-bot" data-testid="said-bot">
				<span className="said-who">mason{item.streaming === true ? " · writing" : ""}</span>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: `renderMarkdown` is the shared renderer, and it drops raw HTML */}
				<div className="said-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
				{item.failed === true ? <p className="said-note">The call that carried this message failed.</p> : null}
			</div>
		);
	}
	if (item.kind === "widget") {
		return (
			<div className="said said-widget" data-testid="said-widget">
				<span className="said-who">widget</span>
				<WidgetCard callId={item.id} content={item.content} streaming={item.streaming} bridgeFor={() => BRIDGE} />
			</div>
		);
	}
	return (
		<div className="said said-notice" data-testid="said-notice">
			{item.text}
		</div>
	);
}

export function Conversation({
	conversation,
	onControl,
}: {
	readonly conversation: ConversationArea;
	readonly onControl: (action: "stop" | "compact") => Promise<unknown>;
}) {
	const action = useAction();
	const { status, transcript, queued } = conversation;
	return (
		<Card
			title="Conversation"
			note="Every connector's words in one room, as the reader sees it. The trace is a separate grant."
			actions={
				<>
					<Badge tone={status.busy ? "accent" : "muted"}>{status.runStatus}</Badge>
					{status.busy ? (
						<button
							type="button"
							className="button"
							disabled={action.pending}
							onClick={() => void action.run(() => onControl("stop"))}
						>
							Stop
						</button>
					) : (
						<button
							type="button"
							className="button ghost"
							disabled={action.pending}
							onClick={() => void action.run(() => onControl("compact"))}
						>
							Compact
						</button>
					)}
				</>
			}
		>
			<ErrorNote error={action.error} />
			{transcript.length === 0 ? (
				<p className="empty">Nothing has been said in this conversation yet.</p>
			) : (
				<div className="said-list">
					{transcript.map((item) => (
						<Row key={item.id} item={item} />
					))}
				</div>
			)}
			{queued.length === 0 ? null : (
				<div className="queue">
					<h3>Queued behind the turn</h3>
					{queued.map((item) => (
						<div className="queue-row" key={item.id}>
							<Badge tone="muted">{item.mode}</Badge>
							<span>{item.text}</span>
							<span className="mono faint">#{item.id}</span>
						</div>
					))}
				</div>
			)}
		</Card>
	);
}
