/**
 * Hooks and routines: the ways the agent is woken without a person saying anything.
 *
 * A hook is a named input the server can fire — a connector's event kind, a schedule (`intervalMs`, which is what a
 * routine is), or a person pressing fire here. The identity and the prompt belong to the build (`src/server/hooks.ts`);
 * what an operator changes is the switch, and whether it ran. Firing one is a whole turn against the model's budget, so
 * this page is behind the administrative grant that spends it.
 */
import type { HookSummary } from "../../../shared/contract.ts";
import { Badge, Card, ErrorNote, useAction } from "../ui.tsx";

export function Hooks({
	hooks,
	onToggle,
	onFire,
	refresh,
}: {
	readonly hooks: readonly HookSummary[];
	readonly onToggle: (id: string, enabled: boolean) => Promise<unknown>;
	readonly onFire: (id: string) => Promise<unknown>;
	readonly refresh: () => Promise<void>;
}) {
	const action = useAction();
	return (
		<Card
			title="Hooks and routines"
			note="A routine is a hook with an interval. A disabled hook still exists; nothing fires it."
			actions={<Badge tone="muted">{hooks.filter((hook) => hook.enabled).length} on</Badge>}
		>
			<ErrorNote error={action.error} />
			{hooks.length === 0 ? (
				<p className="empty">This build defines no hooks.</p>
			) : (
				<table className="table">
					<thead>
						<tr>
							<th>hook</th>
							<th>description</th>
							<th>schedule</th>
							<th>fired</th>
							<th>switch</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{hooks.map((hook) => (
							<tr key={hook.id}>
								<td>
									<span className="mono">{hook.id}</span>
									<div className="faint">{hook.name}</div>
								</td>
								<td>{hook.description}</td>
								<td className="faint">
									{hook.intervalMs === undefined
										? "on demand"
										: `every ${Math.round(hook.intervalMs / 1000)}s`}
								</td>
								<td>
									<div>{hook.fireCount}</div>
									<div className="faint">
										{hook.lastFiredAt === undefined ? "never" : new Date(hook.lastFiredAt).toLocaleString()}
									</div>
								</td>
								<td>
									<button
										type="button"
										className={`button${hook.enabled ? " primary" : ""}`}
										disabled={action.pending}
										onClick={() =>
											void action.run(async () => {
												await onToggle(hook.id, !hook.enabled);
												await refresh();
											})
										}
									>
										{hook.enabled ? "on" : "off"}
									</button>
								</td>
								<td>
									<button
										type="button"
										className="button ghost"
										disabled={action.pending}
										onClick={() =>
											void action.run(async () => {
												await onFire(hook.id);
												await refresh();
											})
										}
									>
										fire
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</Card>
	);
}
