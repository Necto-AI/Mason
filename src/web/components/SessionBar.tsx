/**
 * The session bar: a wordmark and one overflow control.
 *
 * A personal agent is expected to work, so the bar does not narrate it — no status dot, no connection pill, no model
 * name, no counters. What is operational lives where it is useful: a run's progress in the turn itself, the way to
 * stop it next to the composer, and these quieter levers (compact, reset, diagnostics, and the model that answers)
 * one click away. The connection speaks up only when it is not connected, and it says so above the composer.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AgentStatus } from "../../shared/contract.ts";
import type { ConnectionState } from "../client.ts";

export interface SessionBarProps {
	readonly status: AgentStatus | undefined;
	readonly onCompact: () => void;
	readonly onReset: () => void;
}

const RUN_LABELS: Record<string, string> = {
	generating: "generating",
	running_tools: "running tools",
	retrying: "retrying",
	compacting: "compacting",
	idle: "idle",
};

export function SessionBar({ status, onCompact, onReset }: SessionBarProps) {
	const [open, setOpen] = useState(false);
	const menuId = useId();
	const wrap = useRef<HTMLDivElement | null>(null);
	const trigger = useRef<HTMLButtonElement | null>(null);

	const close = useCallback((refocus: boolean) => {
		setOpen(false);
		if (refocus) trigger.current?.focus();
	}, []);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!wrap.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") close(true);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, close]);

	const run = (action: () => void) => () => {
		close(true);
		action();
	};

	const runLabel = status === undefined ? "connecting" : (RUN_LABELS[status.runStatus] ?? status.runStatus);
	return (
		<header id="session-bar" data-testid="session-bar">
			<div id="session-title">
				<span className="title-name">personal agent</span>
			</div>
			<div id="session-menu-wrap" ref={wrap}>
				<button
					type="button"
					id="session-menu-button"
					ref={trigger}
					data-testid="session-menu"
					aria-haspopup="menu"
					aria-expanded={open}
					aria-controls={open ? menuId : undefined}
					aria-label="Session menu"
					title="Session"
					onClick={() => setOpen((value) => !value)}
				>
					<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
						<circle cx="5" cy="12" r="1.6" />
						<circle cx="12" cy="12" r="1.6" />
						<circle cx="19" cy="12" r="1.6" />
					</svg>
				</button>
				{!open ? null : (
					<div id={menuId} className="session-menu" role="menu" data-testid="session-menu-panel">
						<div className="menu-facts">
							<code data-testid="status-run" data-state={runLabel}>
								{status === undefined ? "connecting" : `status: ${runLabel}`}
							</code>
							<code data-testid="status-model">
								{status?.model === undefined ? "model: —" : `model: ${status.model.provider}/${status.model.modelId}`}
							</code>
						</div>
						<button type="button" role="menuitem" data-testid="compact" onClick={run(onCompact)}>
							Compact context
						</button>
						<button type="button" role="menuitem" data-testid="reset" onClick={run(onReset)}>
							Reset session
						</button>
					</div>
				)}
			</div>
		</header>
	);
}
