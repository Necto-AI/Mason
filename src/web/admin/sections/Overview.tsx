/**
 * The state of the deployment at a glance: the agent, the services it reaches, and what is waiting.
 *
 * Health is server state and never a prompt section (`src/server/integration-status.ts`), so this page is the only
 * place the operator sees which integration answered at boot and which one is missing its tools. It is also where a
 * saved-but-not-live configuration says so: `integrations.json` is read once at boot, and a page that hid that would
 * make an operator debug a change that is simply not loaded yet.
 */
import type { PanelState } from "../../../shared/admin.ts";
import { Badge, Card, Fact } from "../ui.tsx";

export function Overview({ state }: { readonly state: PanelState }) {
	const config = state.config;
	const status = state.conversation?.status;
	return (
		<div className="stack">
			{config?.restartRequired === true ? (
				<Card title="Restart to apply" className="warn-card">
					<p>
						<code>integrations.json</code> differs from what this process booted with. Connectors, their grants,
						their triggers and the tool catalog are the boot's, so the change lands on the next start. Tokens,
						roster names and connector credentials are read per request and are already live.
					</p>
				</Card>
			) : null}
			<div className="grid-2">
				<Card title="Agent">
					{status === undefined ? (
						<p className="empty">This device has no conversation grant, so the agent's state is not shown.</p>
					) : (
						<div className="facts">
							<Fact
								label="run"
								value={<Badge tone={status.busy ? "accent" : "muted"}>{status.runStatus}</Badge>}
							/>
							<Fact
								label="tool"
								value={status.runningTools.length === 0 ? "none" : status.runningTools.join(", ")}
							/>
							<Fact
								label="model"
								value={
									status.model === undefined ? "unknown" : `${status.model.provider}/${status.model.modelId}`
								}
							/>
							<Fact label="working dir" value={<span className="mono">{status.cwd ?? "unknown"}</span>} />
							<Fact
								label="hooks"
								value={`${status.hooks.filter((hook) => hook.enabled).length} of ${status.hooks.length} on`}
							/>
						</div>
					)}
				</Card>
				<Card title="This device">
					<div className="facts">
						<Fact label="credential" value={<span className="mono">{state.session.device.id}</span>} />
						<Fact label="label" value={state.session.device.label} />
						<Fact label="speaks as" value={state.session.person ?? "unnamed (the credential is the identity)"} />
						<Fact
							label="grants"
							value={
								<div className="chips">
									{state.session.grants.length === 0 ? (
										<span className="faint">none</span>
									) : (
										state.session.grants.map((grant) => (
											<Badge key={grant} tone="accent">
												{grant}
											</Badge>
										))
									)}
								</div>
							}
						/>
					</div>
				</Card>
			</div>
			{config === undefined ? null : (
				<Card
					title="Integrations"
					note="What the boot's list came to: a service that did not answer loses its tools and says why."
					actions={<Badge tone="muted">{config.health.length} configured</Badge>}
				>
					{config.health.length === 0 ? (
						<p className="empty">No integrations are configured in this home.</p>
					) : (
						<table className="table">
							<thead>
								<tr>
									<th>name</th>
									<th>faces</th>
									<th>connection</th>
									<th>tools</th>
									<th>error</th>
								</tr>
							</thead>
							<tbody>
								{config.health.map((health) => (
									<tr key={health.name}>
										<td className="mono">{health.name}</td>
										<td>
											<div className="chips">
												{health.enabled ? <Badge tone="ok">on</Badge> : <Badge tone="muted">off</Badge>}
												{health.hasTools ? <Badge tone="muted">tools</Badge> : null}
												{health.hasTrigger ? <Badge tone="muted">trigger</Badge> : null}
											</div>
										</td>
										<td>
											{health.connected ? (
												<Badge tone="ok">connected</Badge>
											) : (
												<Badge tone="warn">unreachable</Badge>
											)}
										</td>
										<td>{health.tools}</td>
										<td className="error-cell">{health.error ?? ""}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Card>
			)}
		</div>
	);
}
