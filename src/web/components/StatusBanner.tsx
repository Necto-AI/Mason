/** The explicit status line: connection, run status, tools, queue, and the generative-UI toggle. */
import type { AgentStatus } from "../../shared/contract.ts";
import type { ConnectionState } from "../client.ts";

export interface StatusBannerProps {
	readonly connection: ConnectionState;
	readonly status: AgentStatus | undefined;
	readonly toolsRunning: number;
	readonly toolsTotal: number;
	readonly inboxCount: number;
	readonly onToggleGenUi: (enabled: boolean) => void;
	readonly onOpenHooks: () => void;
	readonly pending: boolean;
}

export function StatusBanner({
	connection,
	status,
	toolsRunning,
	toolsTotal,
	inboxCount,
	onToggleGenUi,
	onOpenHooks,
	pending,
}: StatusBannerProps) {
	const runStatus = status?.runStatus ?? "loading";
	const genUi = status?.sandboxedUiEnabled ?? false;
	return (
		<header className="status" data-testid="status-banner">
			<span
				className={`badge badge-${connection}`}
				data-testid="status-connection"
				data-state={connection}
			>{`CONN: ${connection}`}</span>
			<span
				className={`badge badge-run-${runStatus}`}
				data-testid="status-run"
				data-state={runStatus}
			>{`RUN: ${runStatus}`}</span>
			<span className="badge" data-testid="status-tools">{`TOOLS: ${toolsRunning} running / ${toolsTotal} total`}</span>
			<span className="badge" data-testid="status-inbox">{`INBOX: ${inboxCount} queued`}</span>
			<span className="badge" data-testid="status-model">
				{status?.model === undefined ? "MODEL: —" : `MODEL: ${status.model.provider}/${status.model.modelId}`}
			</span>
			<span className="status-spacer" />
			<button
				type="button"
				className={`chip ${genUi ? "chip-on" : ""}`}
				data-testid="toggle-gen-ui"
				disabled={pending || status === undefined}
				onClick={() => onToggleGenUi(!genUi)}
			>{`GEN-UI: ${genUi ? "enabled" : "disabled"}`}</button>
			<button type="button" className="chip" data-testid="open-hooks" onClick={onOpenHooks}>
				HOOKS
			</button>
		</header>
	);
}
