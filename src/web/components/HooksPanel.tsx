/** The hooks drawer: every event hook the server has, with its switch and a manual fire button. */
import type { AgentStatus } from "../../shared/contract.ts";

export interface HooksPanelProps {
	readonly status: AgentStatus | undefined;
	readonly open: boolean;
	readonly onClose: () => void;
	readonly onToggle: (hookId: string, enabled: boolean) => void;
	readonly onFire: (hookId: string, payload?: string) => void;
	readonly pending: boolean;
}

export function HooksPanel({ status, open, onClose, onToggle, onFire, pending }: HooksPanelProps) {
	if (!open) return null;
	const hooks = status?.hooks ?? [];
	return (
		<aside className="hooks" data-testid="hooks-panel">
			<div className="hooks-head">
				<strong>Event hooks</strong>
				<button type="button" className="chip" data-testid="close-hooks" onClick={onClose}>
					close
				</button>
			</div>
			<p className="hooks-blurb">
				A hook submits a prompt on its own, so the agent can start a turn without you.
			</p>
			<ul className="hooks-list">
				{hooks.map((hook) => (
					<li className="hook" data-testid={`hook-${hook.id}`} key={hook.id}>
						<label className="hook-name">
							<input
								type="checkbox"
								data-testid={`toggle-hook-${hook.id}`}
								checked={hook.enabled}
								disabled={pending}
								onChange={(event) => onToggle(hook.id, event.target.checked)}
							/>
							<span>{hook.name}</span>
						</label>
						<div className="hook-meta">
							<span className="hook-desc">{hook.description}</span>
							<span className="hook-count">
								{`fired ${hook.fireCount}×${hook.lastFiredAt === undefined ? "" : ` • last ${hook.lastFiredAt}`}${
									hook.intervalMs === undefined ? "" : ` • every ${Math.round(hook.intervalMs / 1000)}s`
								}`}
							</span>
						</div>
						<button
							type="button"
							className="chip"
							data-testid={`fire-${hook.id}`}
							disabled={pending}
							onClick={() => onFire(hook.id)}
						>
							fire now
						</button>
					</li>
				))}
			</ul>
			<form
				className="hook-webhook"
				data-testid="webhook-form"
				onSubmit={(event) => {
					event.preventDefault();
					const input = event.currentTarget.elements.namedItem("payload") as HTMLInputElement | null;
					onFire("workspace-check", input?.value === "" ? undefined : input?.value);
				}}
			>
				<label>
					webhook payload
					<input name="payload" placeholder="what happened?" />
				</label>
				<button type="submit" className="chip" data-testid="fire-webhook">
					report
				</button>
			</form>
		</aside>
	);
}
