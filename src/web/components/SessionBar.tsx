/**
 * The session bar: what the agent is doing right now (explicit, in words) and the actions that act on the whole
 * session. sibling's vocabulary kept: a status pill that speaks in colors about processes, quiet pill buttons that
 * collapse to their icons on phones.
 */
import type { AgentStatus } from "../../shared/contract.ts";
import type { ConnectionState } from "../client.ts";

export interface SessionBarProps {
	readonly connection: ConnectionState;
	readonly status: AgentStatus | undefined;
	readonly toolsRunning: number;
	readonly toolsTotal: number;
	readonly inboxCount: number;
	readonly busy: boolean;
	readonly pending: boolean;
	readonly debug: boolean;
	readonly onToggleDebug: () => void;
	readonly onStop: () => void;
	readonly onCompact: () => void;
	readonly onReset: () => void;
}

const ICONS = {
	stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
	compact: '<path d="m12 3 9 6-9 6-9-6Z"/><path d="m3 15 9 6 9-6"/>',
	reset: '<path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8"/><path d="M3 3v5h5"/>',
	debug: '<path d="m8 2 1.5 3"/><path d="M16 2l-1.5 3"/><rect x="5" y="5" width="14" height="14" rx="3"/><path d="M11 10h2"/><path d="M11 14h2"/>',
};

/** The run status in words; the connection state is the pill when the socket is not live. */
function statusOf(
	connection: ConnectionState,
	status: AgentStatus | undefined,
): { state: "idle" | "busy" | "error"; label: string } {
	if (connection === "disconnected") return { state: "error", label: "Disconnected" };
	if (connection === "connecting") return { state: "busy", label: "Connecting\u2026" };
	if (status === undefined) return { state: "busy", label: "Loading\u2026" };
	switch (status.runStatus) {
		case "generating":
			return { state: "busy", label: "Generating" };
		case "running_tools":
			return { state: "busy", label: "Running tools" };
		case "retrying":
			return { state: "busy", label: "Retrying" };
		case "compacting":
			return { state: "busy", label: "Compacting" };
		default:
			return { state: "idle", label: "Idle" };
	}
}

export function SessionBar({
	connection,
	status,
	toolsRunning,
	toolsTotal,
	inboxCount,
	busy,
	pending,
	debug,
	onToggleDebug,
	onStop,
	onCompact,
	onReset,
}: SessionBarProps) {
	const { state, label } = statusOf(connection, status);
	const action = (onClick: () => void, icon: string, text: string, testId: string, disabled: boolean) => (
		<button type="button" data-testid={testId} onClick={onClick} disabled={disabled} title={text} aria-label={text}>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={2}
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
				dangerouslySetInnerHTML={{ __html: icon }}
			/>
			<span>{text}</span>
		</button>
	);
	return (
		<header id="session-bar" data-testid="session-bar">
			<div id="session-title">
				<span className="title-name">personal agent</span>
			</div>
			<div id="session-status" className={state} data-testid="status-run" data-state={state}>
				<span className="dot" />
				<span className="status-label">{label}</span>
				{!busy || toolsTotal === 0 ? null : (
					<span className="badge" data-testid="status-tools">{`${toolsRunning}/${toolsTotal} tools`}</span>
				)}
				{inboxCount === 0 ? null : (
					<span className="badge" data-testid="status-inbox">{`${inboxCount} queued`}</span>
				)}
				<span className="badge" data-testid="status-model">
					{status?.model === undefined ? "—" : `${status.model.provider}/${status.model.modelId}`}
				</span>
				<span className="badge" data-testid="status-connection" data-state={connection}>
					{connection}
				</span>
			</div>
			<div id="session-actions">
				{action(onStop, ICONS.stop, "Stop", "stop", pending || !busy)}
				{action(onCompact, ICONS.compact, "Compact", "compact", pending || busy)}
				{action(onReset, ICONS.reset, "Reset", "reset", pending || busy)}
				{action(onToggleDebug, ICONS.debug, debug ? "Debug on" : "Debug", "toggle-debug", false)}
			</div>
		</header>
	);
}
