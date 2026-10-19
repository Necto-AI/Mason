/**
 * The durable inbox: submissions waiting for a boundary, shown as faded user bubbles at the end of the chat —
 * after the running turn, where the agent's next input lands anyway, each tagged with the boundary it waits for.
 * The inbox is durable state, so the rows show whenever the queue holds items, busy or not, run alive or dead:
 * a provider error leaves the queue in place for the restart to pick up.
 *
 * The withdraw button is the durable backend's only: while the server cannot settle a submission any more, the
 * item is here for display, and the button goes. For plain user inputs that is never (withdrawable throughout
 * the queue; placement empties the doc); an input meant to become a hook trigger or an entry write cannot be
 * withdrawn any more once the inbox knows its entry.
 */
import type { InboxItemLike, JsonValue } from "../view-types.ts";
import { HOOK_ENTRY_KIND } from "../../shared/contract.ts";

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
	if (item.entry?.kind === HOOK_ENTRY_KIND) return `hook: ${data?.hookName ?? "event"}`;
	return item.entry?.kind ?? "submission";
}

function tagOf(mode: InboxItemLike["mode"]): string {
	if (mode === "steer") return "steering";
	if (mode === "followUp") return "follow-up";
	return "write";
}

/**
 * Whether the inbox no longer holds plain queued user text, so there is nothing to withdraw: the item carries an
 * entry — a write, or an input that fires a hook instead of starting a run.
 */
function withdrawable(item: InboxItemLike): boolean {
	return item.entry === undefined;
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
						{withdrawable(item) ? (
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
						) : null}
						{debug ? <code className="debug-inline">{`id=${item.id} mode=${item.mode}`}</code> : null}
					</div>
				</article>
			))}
		</>
	);
}
