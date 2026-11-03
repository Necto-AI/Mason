/**
 * Access: the credentials a browser or device holds, and the grants each one carries.
 *
 * A token is minted once and stored as a hash, so this page can narrow and revoke what exists but can never show a
 * secret it did not just mint. The grants are the panel's powers (`src/shared/admin.ts`): the projected conversation,
 * the raw trace, the configuration, and the pending questions. A change is read per request, so narrowing a device
 * lands on that device's very next call — including this one.
 */
import { useState } from "react";
import type { OperatorGrant, PanelCredential, PanelState } from "../../../shared/admin.ts";
import { grantsOf } from "../../../shared/admin.ts";
import { Badge, Card, ErrorNote, Once, useAction } from "../ui.tsx";

type Config = NonNullable<PanelState["config"]>;

function GrantPicker({
	grants,
	choices,
	onChange,
}: {
	readonly grants: readonly OperatorGrant[];
	readonly choices: readonly OperatorGrant[];
	readonly onChange: (next: OperatorGrant[]) => void;
}) {
	return (
		<div className="chips">
			{choices.map((grant) => (
				<label className="check" key={grant}>
					<input
						type="checkbox"
						checked={grants.includes(grant)}
						onChange={(event) => {
							const next = event.currentTarget.checked
								? [...grants, grant]
								: grants.filter((entry) => entry !== grant);
							onChange(choices.filter((entry) => next.includes(entry)));
						}}
					/>
					<span>{grant}</span>
				</label>
			))}
		</div>
	);
}

export function Access({
	config,
	onMint,
	onGrants,
	onRevoke,
	onRevokeCredential,
	refresh,
}: {
	readonly config: Config;
	readonly onMint: (label: string, grants: OperatorGrant[]) => Promise<{ token: string; id: string }>;
	readonly onGrants: (id: string, grants: OperatorGrant[]) => Promise<unknown>;
	readonly onRevoke: (id: string) => Promise<unknown>;
	readonly onRevokeCredential: (id: string) => Promise<unknown>;
	readonly refresh: () => Promise<void>;
}) {
	const [label, setLabel] = useState("");
	const [grants, setGrants] = useState<OperatorGrant[]>(["conversation"]);
	const [minted, setMinted] = useState<string | undefined>(undefined);
	const action = useAction();

	return (
		<div className="stack">
			<Card
				title="Devices"
				note="One credential per browser or device. The token is printed once; the file holds only its hash."
			>
				<ErrorNote error={action.error} />
				<table className="table">
					<thead>
						<tr>
							<th>id</th>
							<th>label</th>
							<th>created</th>
							<th>grants</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{config.tokens.map((token) => (
							<tr key={token.id}>
								<td className="mono">{token.id}</td>
								<td>{token.label}</td>
								<td className="faint">{new Date(token.createdAt).toLocaleString()}</td>
								<td>
									<GrantPicker
										grants={grantsOf(token)}
										choices={config.grants}
										onChange={(next) =>
											void action.run(async () => {
												await onGrants(token.id, next);
												await refresh();
											})
										}
									/>
								</td>
								<td>
									<button
										type="button"
										className="button ghost danger-text"
										disabled={action.pending}
										onClick={() =>
											void action.run(async () => {
												await onRevoke(token.id);
												await refresh();
											})
										}
									>
										revoke
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
				<div className="row-inline">
					<input value={label} placeholder="phone" onChange={(event) => setLabel(event.currentTarget.value)} />
					<GrantPicker grants={grants} choices={config.grants} onChange={setGrants} />
					<button
						type="button"
						className="button primary"
						disabled={action.pending}
						onClick={() =>
							void action.run(async () => {
								const created = await onMint(label.trim() === "" ? "device" : label.trim(), grants);
								setMinted(created.token);
								setLabel("");
								await refresh();
							})
						}
					>
						Mint a device
					</button>
				</div>
				{minted === undefined ? null : <Once label="pairing token" value={minted} />}
			</Card>
			<ConnectorCredentials credentials={config.credentials} onRevoke={onRevokeCredential} refresh={refresh} />
		</div>
	);
}

function ConnectorCredentials({
	credentials,
	onRevoke,
	refresh,
}: {
	readonly credentials: readonly PanelCredential[];
	readonly onRevoke: (id: string) => Promise<unknown>;
	readonly refresh: () => Promise<void>;
}) {
	const action = useAction();
	return (
		<Card
			title="Connector credentials"
			note="Mason-issued proof that a process is the connector its entry describes. It opens the socket and the attachment bytes, and nothing else."
			actions={<Badge tone="muted">{credentials.length}</Badge>}
		>
			<ErrorNote error={action.error} />
			{credentials.length === 0 ? (
				<p className="empty">No connector has a credential yet. Mint one on the connectors page.</p>
			) : (
				<table className="table">
					<thead>
						<tr>
							<th>id</th>
							<th>connector</th>
							<th>issued</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{credentials.map((record) => (
							<tr key={record.id}>
								<td className="mono">{record.id}</td>
								<td className="mono">{record.connector}</td>
								<td className="faint">{new Date(record.createdAt).toLocaleString()}</td>
								<td>
									<button
										type="button"
										className="button ghost danger-text"
										disabled={action.pending}
										onClick={() =>
											void action.run(async () => {
												await onRevoke(record.id);
												await refresh();
											})
										}
									>
										revoke
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
