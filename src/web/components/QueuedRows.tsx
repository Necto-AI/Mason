/**
 * The durable inbox as the reader sees it: submissions waiting for a boundary, shown as faded bubbles after the
 * transcript, each tagged with the boundary it waits for.
 *
 * The server has already labelled them — the reader's own words, or the hook an input becomes — so nothing here reads
 * the machine's shapes. The withdraw button is the durable backend's only: once the inbox has turned an input into an
 * entry there is nothing left to take back, and the server says so.
 */
import type { QueuedItem } from "../../shared/contract.ts";

export interface QueuedRowsProps {
	readonly items: readonly QueuedItem[];
	readonly onWithdraw: (submissionId: number) => void;
}

function tagOf(mode: string): string {
	if (mode === "steer") return "steering";
	if (mode === "followUp") return "follow-up";
	return "write";
}

export function QueuedRows({ items, onWithdraw }: QueuedRowsProps) {
	if (items.length === 0) return null;
	return (
		<>
			{items.map((item) => (
				<article className="message user queued" key={item.id} data-testid="inbox-item">
					<div className="bubble">
						{item.text}
						<span className="tag" data-testid={`inbox-mode-${item.id}`}>
							{tagOf(item.mode)}
						</span>
						{item.withdrawable ? (
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
					</div>
				</article>
			))}
		</>
	);
}
