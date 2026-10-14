/**
 * The durable inbox: submissions waiting for a boundary, shown as faded user bubbles in front of the running
 * turn, each tagged with the boundary it waits for and each withdrawable by id.
 */
import type { InboxItemLike, JsonValue } from "../view-types.ts";

export interface QueuedRowsProps {
	readonly items: readonly InboxItemLike[];
	readonly onWithdraw: (submissionId: number) => void;
	readonly debug: boolean;
}

/** The text of a queued submission: its content, or the entry it will be placed as. */
function labelOf(item: InboxItemLike): string {
	const content = item.content as JsonValue | undefined;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part !== null && typeof part === "object" && "text" in part ? String(part.text) : ""))
			.join("");
	}
	const data = item.entry?.data as { hookName?: string } | undefined;
	if (item.entry?.kind === "app.hook") return `hook: ${data?.hookName ?? "event"}`;
	return item.entry?.kind ?? "submission";
}

function tagOf(mode: InboxItemLike["mode"]): string {
	if (mode === "steer") return "steering";
	if (mode === "followUp") return "follow-up";
	return "write";
}

export function QueuedRows({ items, onWithdraw, debug }: QueuedRowsProps) {
	if (items.length === 0) return null;
	return (
		<>
			{items.map((item) => (
				<article className="message user queued" key={item.id} data-testid="inbox-item">
					<div className="bubble">
						{labelOf(item)}
						<span className="tag" data-testid={`inbox-mode-${item.id}`}>
							{tagOf(item.mode)}
						</span>
						<button
							type="button"
							className="withdraw"
							title="withdraw this submission"
							aria-label="withdraw"
							data-testid={`withdraw-${item.id}`}
							onClick={() => onWithdraw(item.id)}
						>
							{"\u2715"}
						</button>
						{debug ? <code className="debug-inline">{`id=${item.id} mode=${item.mode}`}</code> : null}
					</div>
				</article>
			))}
		</>
	);
}
