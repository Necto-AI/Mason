/** The durable inbox: submissions that are queued behind the running turn, and how to withdraw them. */
import type { InboxStateLike, JsonObject } from "../view-types.ts";

export interface InboxBarProps {
	readonly inbox: InboxStateLike | undefined;
	readonly onWithdraw: (submissionId: number) => void;
}

function label(item: { mode: string; content?: unknown; entry?: { kind: string; data?: JsonObject } }): string {
	if (typeof item.content === "string") return item.content;
	const data = item.entry?.data as { hookName?: string } | undefined;
	if (item.entry?.kind === "app.hook") return `hook: ${data?.hookName ?? "event"}`;
	return item.entry?.kind ?? "submission";
}

export function InboxBar({ inbox, onWithdraw }: InboxBarProps) {
	const items = inbox?.items ?? [];
	if (items.length === 0) return null;
	return (
		<section className="inbox" data-testid="inbox">
			<span className="inbox-title">{`QUEUED (${items.length})`}</span>
			<ul className="inbox-list">
				{items.map((item) => (
					<li className="inbox-item" data-testid="inbox-item" key={item.id}>
						<span className="badge badge-mode">{`[QUEUED: ${item.mode}]`}</span>
						<span className="inbox-text">{label(item)}</span>
						<button
							type="button"
							className="chip"
							data-testid={`withdraw-${item.id}`}
							onClick={() => onWithdraw(item.id)}
						>
							withdraw
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}
