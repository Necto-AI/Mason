/**
 * Debug mode: everything the durable backend exposes that the normal view hides — retry and compaction status,
 * hook controls, the spend ledger, and a raw inspector over the conversation's documents. `?debug=1` or the
 * session bar's DEBUG toggle switches it on.
 */
import { useState, type ReactNode } from "react";
import {
	agentDoc,
	inbox as inboxOf,
	live as liveOf,
	provider as providerOf,
	type ConversationViewLike,
	type LiveStateLike,
	type UsageStateLike,
} from "../view-types.ts";

/** Seconds until `at`, for a chip that keeps counting while the reader watches. */
function countdown(at: number, now: number): string {
	return `${Math.max(0, Math.ceil((at - now) / 1000))}s`;
}

function clock(at: number): string {
	const date = new Date(at);
	return Number.isNaN(date.getTime()) ? String(at) : date.toISOString().replace("T", " ").slice(0, 19);
}

/** Retry, deferred and compaction status of the running turn: chips above the live bubbles. */
export function LiveChips({
	live,
	busy,
	debug,
	now,
}: {
	live: LiveStateLike | undefined;
	busy: boolean;
	debug: boolean;
	now: number;
}) {
	const chips: ReactNode[] = [];
	const generation = live?.generation;
	if (generation?.retry !== undefined) {
		chips.push(
			<span className="chip chip-error" data-testid="chip-retry" key="retry">
				{`retry in ${countdown(generation.retry.at, now)} \u2014 ${generation.retry.error}`}
				{debug ? <code>{` at=${clock(generation.retry.at)}`}</code> : null}
			</span>,
		);
	}
	if (generation?.deferred !== undefined) {
		chips.push(
			<span className="chip" data-testid="chip-deferred" key="deferred">
				{`waiting \u2014 provider deferred`}
				{debug ? <code>{` pollAt=${clock(generation.deferred.pollAt)}`}</code> : null}
			</span>,
		);
	}
	for (const compaction of live?.compactions ?? []) {
		chips.push(
			<span className="chip" data-testid="chip-compaction" key={`compaction-${compaction.taskId}`}>
				{`compacting \u00b7 ${compaction.reason} \u00b7 attempt ${compaction.attempt}${
					compaction.blocking ? " \u00b7 blocking" : ""
				}${compaction.retry === undefined ? "" : ` \u00b7 retry in ${countdown(compaction.retry.at, now)}`}`}
			</span>,
		);
	}
	const failure = live?.compactionFailure;
	if (failure !== undefined && (busy || debug)) {
		chips.push(
			<span className="chip chip-error" data-testid="compaction-failure" key="failure">
				{`compaction failed \u00b7 ${failure.reason} \u00b7 ${failure.error}`}
				{debug ? <code>{` taskId=${failure.taskId}`}</code> : null}
			</span>,
		);
	}
	if (chips.length === 0) return null;
	return (
		<div className="chip-row" data-testid="live-chips">
			{chips}
		</div>
	);
}

/** The conversation's spend, per model and per tool (`pi.usage`). */
export function UsagePanel({ usage }: { usage: UsageStateLike | undefined }) {
	const models = Object.entries(usage?.models ?? {});
	const tools = Object.entries(usage?.tools ?? {});
	if (models.length === 0 && tools.length === 0) return null;
	const row = (key: string, value: UsageStateLike["models"][string]): ReactNode => (
		<tr key={key}>
			<td>{key}</td>
			<td>{value.input}</td>
			<td>{value.output}</td>
			<td>{value.cacheRead}</td>
			<td>{value.cacheWrite}</td>
			<td>{value.totalTokens}</td>
			<td>{`$${value.cost.total.toFixed(4)}`}</td>
		</tr>
	);
	return (
		<details className="debug-panel" data-testid="usage-panel">
			<summary>{"usage"}</summary>
			<table className="usage">
				<thead>
					<tr>
						<th>bucket</th>
						<th>in</th>
						<th>out</th>
						<th>cache r</th>
						<th>cache w</th>
						<th>total</th>
						<th>cost</th>
					</tr>
				</thead>
				<tbody>
					{models.map(([key, value]) => row(`model ${key}`, value))}
					{tools.map(([key, value]) => row(`tool ${key}`, value))}
				</tbody>
			</table>
		</details>
	);
}

export interface DebugSheetProps {
	readonly connection: string;
	readonly view: ConversationViewLike | undefined;
	readonly live: LiveStateLike | undefined;
	readonly hooks: readonly { id: string; name: string; enabled: boolean; fireCount: number }[];
	readonly sandboxedUiEnabled: boolean;
	readonly pending: boolean;
	readonly onFireHook: (hookId: string, payload: string | undefined) => void;
	readonly onToggleHook: (hookId: string, enabled: boolean) => void;
	readonly onToggleGenUi: (enabled: boolean) => void;
}

/** The debug sheet: run internals, hook controls and the raw documents. */
export function DebugSheet({
	connection,
	view,
	live,
	hooks,
	sandboxedUiEnabled,
	pending,
	onFireHook,
	onToggleHook,
	onToggleGenUi,
}: DebugSheetProps) {
	const [payload, setPayload] = useState("");
	const agent = agentDoc(view);
	const provider = providerOf(view);
	const documents: Record<string, unknown> = {
		"pi.live": live ?? null,
		"pi.inbox": inboxOf(view) ?? null,
		"pi.agent": agent ?? null,
		"pi.provider": provider ?? null,
	};
	return (
		<details className="debug-panel" data-testid="debug-sheet" open>
			<summary>{"debug"}</summary>
			<div className="debug-facts">
				<code>{`connection=${connection}`}</code>
				<code>{`model=${agent?.model === undefined ? "—" : `${agent.model.provider}/${agent.model.modelId}`}`}</code>
				<code>{`cwd=${agent?.cwd ?? "—"}`}</code>
				<code>{`run=${live?.run === undefined ? "idle" : `task ${live.run.taskId} inputs ${live.run.inputs.join(",")}`}`}</code>
				<code>{`providerSession=${provider?.sessionId ?? "—"}`}</code>
				<code>{`generation=${live?.generation === undefined ? "—" : `attempt ${live.generation.attempt}`}`}</code>
				<div className="debug-line">
					<button
						type="button"
						className={`chip ${sandboxedUiEnabled ? "chip-on" : ""}`}
						data-testid="toggle-gen-ui"
						disabled={pending}
						onClick={() => onToggleGenUi(!sandboxedUiEnabled)}
					>{`generateSandboxedUi: ${sandboxedUiEnabled ? "enabled" : "disabled"}`}</button>
				</div>
			</div>
			<div className="debug-hooks">
				<h4>hooks</h4>
				{hooks.map((hook) => (
					<div className="debug-line" key={hook.id} data-testid={`debug-hook-${hook.id}`}>
						<label>
							<input
								type="checkbox"
								checked={hook.enabled}
								disabled={pending}
								onChange={(event) => onToggleHook(hook.id, event.currentTarget.checked)}
							/>
							{` ${hook.name}`}
						</label>
						<code>{`fired ${hook.fireCount}\u00d7`}</code>
						<button
							type="button"
							className="chip"
							disabled={pending}
							data-testid={`fire-${hook.id}`}
							onClick={() => onFireHook(hook.id, payload.trim() === "" ? undefined : payload)}
						>
							Fire now
						</button>
					</div>
				))}
				<textarea
					className="debug-payload"
					data-testid="hook-payload"
					rows={2}
					placeholder="payload for the next hook fire (optional)"
					value={payload}
					onChange={(event) => setPayload(event.currentTarget.value)}
				/>
			</div>
			{Object.entries(documents).map(([name, value]) => (
				<details className="debug-doc" key={name}>
					<summary>{name}</summary>
					<pre className="step-block">{JSON.stringify(value, null, 2) ?? "null"}</pre>
				</details>
			))}
		</details>
	);
}
