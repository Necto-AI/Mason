/**
 * Connectors: the entries, their grants, their policies and their credentials.
 *
 * An integration's `connector` block is a ceiling, never a wish (`src/server/connectors.ts`): the one actor that speaks
 * for the owner, the rooms it may speak in, the event kinds it may fire, the state it may mirror and the tools it may run
 * without asking. This page edits that ceiling. Nothing here decides a tool call — the gateway does, from this file — so
 * the policy lists are the operator's rules spelled as the server reads them, and the page says which way they tighten:
 * `deny` beats `ask` beats `allow`, and no marker widens a rule.
 *
 * `integrations.json` is read once at boot, so every save here says "restart to apply". The credentials are the
 * exception: they are read per upgrade, and a revoke lands on the next connection.
 */
import { useState } from "react";
import type { ConnectorPatch, PanelConnector, PanelHealth, PanelState } from "../../../shared/admin.ts";
import { Badge, Card, ErrorNote, Field, Once, Toggle, useAction } from "../ui.tsx";

type Config = NonNullable<PanelState["config"]>;

export interface ConnectorActions {
	save(name: string, patch: ConnectorPatch): Promise<unknown>;
	create(name: string, toolsUrl: string, description: string): Promise<unknown>;
	remove(name: string): Promise<unknown>;
	mintCredential(name: string, replace: boolean): Promise<{ credential: string }>;
	revokeCredential(id: string): Promise<unknown>;
}

/**
 * An editable row. `key` is the row's identity in React's list: an index would survive a remove and hand the next
 * row's control the previous row's state, which is the bug the row key exists to prevent.
 */
let nextRow = 0;
function rowKey(): string {
	nextRow += 1;
	return `row-${nextRow}`;
}

interface ConversationRow {
	readonly key: string;
	readonly externalConversationId: string;
	readonly kind: "person" | "room";
	readonly title: string;
}

interface HookRow {
	readonly key: string;
	readonly kind: string;
	readonly hook: string;
}

interface Draft {
	readonly enabled: boolean;
	readonly description: string;
	readonly toolsUrl: string;
	readonly toolsRequired: boolean;
	readonly toolsCredential: string;
	readonly commands: readonly string[];
	readonly hasConnector: boolean;
	readonly user: null | {
		readonly owner: string;
		readonly conversations: readonly ConversationRow[];
	};
	readonly events: null | { readonly hooks: readonly HookRow[] };
	readonly state: readonly string[];
	readonly trustMarkers: boolean;
	readonly policy: { readonly allow: string; readonly ask: string; readonly deny: string };
}

function draftOf(connector: PanelConnector): Draft {
	const grant = connector.connector;
	return {
		enabled: connector.enabled,
		description: connector.description ?? "",
		toolsUrl: connector.tools?.url ?? "",
		toolsRequired: connector.tools?.required ?? false,
		toolsCredential: "",
		commands: grant?.commands === undefined ? [] : [...grant.commands],
		hasConnector: grant !== null,
		user:
			grant?.user === undefined
				? null
				: {
						owner: grant.user.owner ?? "",
						conversations: (grant.user.conversations ?? []).map((room) => ({
							key: rowKey(),
							externalConversationId: room.externalConversationId,
							kind: room.kind,
							title: room.title ?? "",
						})),
					},
		events:
			grant?.events === undefined
				? null
				: {
						hooks: Object.entries(grant.events.hooks).map(([kind, hook]) => ({ key: rowKey(), kind, hook })),
					},
		state: grant?.state ?? [],
		trustMarkers: grant?.trustMarkers ?? false,
		policy: {
			allow: (grant?.policy?.allow ?? []).join("\n"),
			ask: (grant?.policy?.ask ?? []).join("\n"),
			deny: (grant?.policy?.deny ?? []).join("\n"),
		},
	};
}

function lines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

function patchOf(draft: Draft): ConnectorPatch {
	return {
		enabled: draft.enabled,
		description: draft.description.trim(),
		tools:
			draft.toolsUrl.trim() === ""
				? null
				: {
						url: draft.toolsUrl.trim(),
						required: draft.toolsRequired,
						...(draft.toolsCredential.trim() === "" ? {} : { credential: draft.toolsCredential.trim() }),
					},
		connector: draft.hasConnector
			? {
					user:
						draft.user === null
							? null
							: {
									owner: draft.user.owner.trim() === "" ? null : draft.user.owner.trim(),
									conversations: draft.user.conversations
										.filter((room) => room.externalConversationId.trim() !== "")
										.map((room) => ({
											externalConversationId: room.externalConversationId.trim(),
											kind: room.kind,
											...(room.title.trim() === "" ? {} : { title: room.title.trim() }),
										})),
								},
					events:
						draft.events === null
							? null
							: {
									hooks: Object.fromEntries(
										draft.events.hooks
											.filter((row) => row.kind.trim() !== "" && row.hook !== "")
											.map((row) => [row.kind.trim(), row.hook]),
									),
								},
					state: draft.state,
					commands: draft.commands,
					trustMarkers: draft.trustMarkers,
					policy: {
						allow: lines(draft.policy.allow),
						ask: lines(draft.policy.ask),
						deny: lines(draft.policy.deny),
					},
				}
			: null,
	};
}

function Checkbox({
	checked,
	label,
	onChange,
}: {
	readonly checked: boolean;
	readonly label: string;
	readonly onChange: (next: boolean) => void;
}) {
	return (
		<label className="check">
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
			<span>{label}</span>
		</label>
	);
}

function ConnectorCard({
	connector,
	health,
	config,
	credentials,
	actions,
	refresh,
}: {
	readonly connector: PanelConnector;
	readonly health: PanelHealth | undefined;
	readonly config: Config;
	readonly credentials: readonly { id: string; createdAt: string }[];
	readonly actions: ConnectorActions;
	readonly refresh: () => Promise<void>;
}) {
	const [draft, setDraft] = useState<Draft>(() => draftOf(connector));
	const [minted, setMinted] = useState<{ label: string; value: string } | undefined>(undefined);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const action = useAction();
	const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

	const save = async () => {
		await action.run(async () => {
			await actions.save(connector.name, patchOf(draft));
			await refresh();
		});
	};

	const toggleEnabled = async (next: boolean) => {
		update({ enabled: next });
		await action.run(async () => {
			await actions.save(connector.name, { enabled: next });
			await refresh();
		});
	};

	const faceBadges = (
		<div className="chips">
			{connector.tools === null ? null : <Badge tone="muted">tools</Badge>}
			{connector.connector?.user === undefined ? null : <Badge tone="muted">user</Badge>}
			{connector.connector?.events === undefined ? null : <Badge tone="muted">events</Badge>}
			{health === undefined ? null : health.connected ? (
				<Badge tone="ok">connected</Badge>
			) : connector.tools === null ? null : (
				<Badge tone="warn">unreachable</Badge>
			)}
		</div>
	);

	return (
		<Card
			title={
				<span className="card-title-row">
					<span className="mono">{connector.name}</span>
					{faceBadges}
				</span>
			}
			actions={
				<>
					<Toggle
						checked={draft.enabled}
						label={`enable ${connector.name}`}
						onChange={(next) => void toggleEnabled(next)}
					/>
					<button type="button" className="button primary" disabled={action.pending} onClick={() => void save()}>
						Save
					</button>
				</>
			}
		>
			<ErrorNote error={action.error} />
			{health?.error === null || health?.error === undefined ? null : (
				<p className="error-note">Last connection: {health.error}</p>
			)}
			<div className="form-grid">
				<Field label="description" wide hint="The one line the model is told about this service's tools.">
					<input
						value={draft.description}
						placeholder="GitHub issues and pull requests"
						onChange={(event) => update({ description: event.currentTarget.value })}
					/>
				</Field>
				<Field label="tools url" hint="An MCP endpoint over Streamable HTTP. Empty removes the tools face.">
					<input
						value={draft.toolsUrl}
						placeholder="http://mason-github:8082/mcp"
						className="mono"
						onChange={(event) => update({ toolsUrl: event.currentTarget.value })}
					/>
				</Field>
				<Field
					label="tools credential"
					hint={
						connector.tools?.hasCredential === true
							? "set — type a new one to replace it"
							: "the credential this service issued mason"
					}
				>
					<input
						value={draft.toolsCredential}
						placeholder={connector.tools?.hasCredential === true ? "unchanged" : "none"}
						onChange={(event) => update({ toolsCredential: event.currentTarget.value })}
					/>
				</Field>
				<div className="check-row">
					<Checkbox
						checked={draft.toolsRequired}
						label="required: a dead server refuses the boot"
						onChange={(next) => update({ toolsRequired: next })}
					/>
				</div>
			</div>

			<div className="face-head">
				<h3>Connector grant</h3>
				{draft.hasConnector ? (
					<button
						type="button"
						className="button ghost"
						onClick={() => update({ hasConnector: false })}
						title="The entry keeps its tools face; a credential then opens nothing."
					>
						Remove the grant
					</button>
				) : (
					<button type="button" className="button ghost" onClick={() => update({ hasConnector: true })}>
						Add a connector grant
					</button>
				)}
			</div>
			{draft.hasConnector ? (
				<>
					{draft.user === null ? (
						<button
							type="button"
							className="button ghost"
							onClick={() => update({ user: { owner: "", conversations: [] } })}
						>
							Add a user face
						</button>
					) : (
						<div className="subcard">
							<header className="subcard-head">
								<h4>User face</h4>
								<button type="button" className="button ghost" onClick={() => update({ user: null })}>
									Remove the user face
								</button>
							</header>
							<Field
								label="owner"
								hint="The external actor id whose words are yours. Every other actor is refused; none means this face carries only unattributed notices, and nobody may answer through it."
							>
								<input
									value={draft.user.owner}
									placeholder="external actor id"
									className="mono"
									onChange={(event) =>
										draft.user === null
											? undefined
											: update({ user: { ...draft.user, owner: event.currentTarget.value } })
									}
								/>
							</Field>
							<h5>Rooms</h5>
							<p className="hint">An external conversation this face may carry words in. Absent: none.</p>
							{draft.user.conversations.map((room, index) => (
								<div className="row-triple" key={room.key}>
									<input
										value={room.externalConversationId}
										placeholder="external conversation id"
										className="mono"
										onChange={(event) => {
											const conversations = draft.user?.conversations.map((entry, at) =>
												at === index
													? { ...entry, externalConversationId: event.currentTarget.value }
													: entry,
											);
											if (conversations !== undefined && draft.user !== null)
												update({ user: { ...draft.user, conversations } });
										}}
									/>
									<select
										value={room.kind}
										onChange={(event) => {
											const kind: "person" | "room" =
												event.currentTarget.value === "room" ? "room" : "person";
											const conversations = draft.user?.conversations.map((entry, at) =>
												at === index ? { ...entry, kind } : entry,
											);
											if (conversations !== undefined && draft.user !== null)
												update({ user: { ...draft.user, conversations } });
										}}
									>
										<option value="person">person</option>
										<option value="room">room</option>
									</select>
									<input
										value={room.title}
										placeholder="title (optional)"
										onChange={(event) => {
											const conversations = draft.user?.conversations.map((entry, at) =>
												at === index ? { ...entry, title: event.currentTarget.value } : entry,
											);
											if (conversations !== undefined && draft.user !== null)
												update({ user: { ...draft.user, conversations } });
										}}
									/>
									<button
										type="button"
										className="button ghost"
										onClick={() =>
											draft.user === null
												? undefined
												: update({
														user: {
															...draft.user,
															conversations: draft.user.conversations.filter((_, at) => at !== index),
														},
													})
										}
									>
										remove
									</button>
								</div>
							))}
							<button
								type="button"
								className="button ghost"
								onClick={() =>
									draft.user === null
										? undefined
										: update({
												user: {
													...draft.user,
													conversations: [
														...draft.user.conversations,
														{
															key: rowKey(),
															externalConversationId: "",
															kind: "person",
															title: "",
														},
													],
												},
											})
								}
							>
								Add a room
							</button>
						</div>
					)}

					{draft.events === null ? (
						<button type="button" className="button ghost" onClick={() => update({ events: { hooks: [] } })}>
							Add an events face
						</button>
					) : (
						<div className="subcard">
							<header className="subcard-head">
								<h4>Events face</h4>
								<button type="button" className="button ghost" onClick={() => update({ events: null })}>
									Remove the events face
								</button>
							</header>
							<p className="hint">Which event kind fires which hook. A kind absent from this list is refused.</p>
							{draft.events.hooks.map((row, index) => (
								<div className="row-pair" key={row.key}>
									<input
										value={row.kind}
										placeholder="event kind"
										className="mono"
										onChange={(event) => {
											if (draft.events === null) return;
											const hooks = draft.events.hooks.map((entry, at) =>
												at === index ? { ...entry, kind: event.currentTarget.value } : entry,
											);
											update({ events: { hooks } });
										}}
									/>
									<select
										value={row.hook}
										onChange={(event) => {
											if (draft.events === null) return;
											const hooks = draft.events.hooks.map((entry, at) =>
												at === index ? { ...entry, hook: event.currentTarget.value } : entry,
											);
											update({ events: { hooks } });
										}}
									>
										<option value="">— pick a hook —</option>
										{config.hooks.map((entry) => (
											<option key={entry.id} value={entry.id}>
												{entry.name} ({entry.id})
											</option>
										))}
									</select>
									<button
										type="button"
										className="button ghost"
										onClick={() =>
											draft.events === null
												? undefined
												: update({ events: { hooks: draft.events.hooks.filter((_, at) => at !== index) } })
										}
									>
										remove
									</button>
								</div>
							))}
							<button
								type="button"
								className="button ghost"
								onClick={() =>
									draft.events === null
										? undefined
										: update({
												events: {
													hooks: [
														...draft.events.hooks,
														{ key: rowKey(), kind: "", hook: config.hooks[0]?.id ?? "" },
													],
												},
											})
								}
							>
								Add a kind
							</button>
						</div>
					)}

					<div className="subcard">
						<h4>State, policy and commands</h4>
						<h5>State scopes</h5>
						<div className="check-row">
							{config.stateScopes.map((scope) => (
								<Checkbox
									key={scope}
									checked={draft.state.includes(scope)}
									label={scope}
									onChange={(next) =>
										update({
											state: next ? [...draft.state, scope] : draft.state.filter((entry) => entry !== scope),
										})
									}
								/>
							))}
						</div>
						<div className="check-row">
							<Checkbox
								checked={draft.trustMarkers}
								label="trust this connector's approval markers"
								onChange={(next) => update({ trustMarkers: next })}
							/>
						</div>
						<p className="hint">
							Trusted markers let a tool that declares <code>not_required</code> run without asking. A{" "}
							<code>required</code> marker always asks, and a deny rule always wins.
						</p>
						<div className="policy-grid">
							<Field label="allow" hint="One tool name per line, or * for every tool.">
								<textarea
									rows={3}
									value={draft.policy.allow}
									onChange={(event) =>
										update({ policy: { ...draft.policy, allow: event.currentTarget.value } })
									}
								/>
							</Field>
							<Field label="ask" hint="Asks unless a deny rule matches.">
								<textarea
									rows={3}
									value={draft.policy.ask}
									onChange={(event) => update({ policy: { ...draft.policy, ask: event.currentTarget.value } })}
								/>
							</Field>
							<Field label="deny" hint="Refuses before anything else is consulted.">
								<textarea
									rows={3}
									value={draft.policy.deny}
									onChange={(event) =>
										update({ policy: { ...draft.policy, deny: event.currentTarget.value } })
									}
								/>
							</Field>
						</div>
						<h5>Commands</h5>
						<p className="hint">
							What this connector may ask for on <code>mason/control</code>: the four words a chat can send back.
						</p>
						<div className="check-row">
							{config.commands.map((command) => (
								<Checkbox
									key={command}
									checked={draft.commands.includes(command)}
									label={command}
									onChange={(next) =>
										update({
											commands: next
												? [...draft.commands, command]
												: draft.commands.filter((entry) => entry !== command),
										})
									}
								/>
							))}
						</div>
					</div>
				</>
			) : null}

			<div className="subcard">
				<header className="subcard-head">
					<h4>Credentials</h4>
					<button
						type="button"
						className="button"
						disabled={action.pending}
						onClick={() =>
							void action.run(async () => {
								const mintedNow = await actions.mintCredential(connector.name, true);
								setMinted({ label: `credential for ${connector.name}`, value: mintedNow.credential });
								await refresh();
							})
						}
					>
						Issue a credential (replacing the old ones)
					</button>
				</header>
				{credentials.length === 0 ? (
					<p className="hint">No credential. A connector process opens its socket with one of its own.</p>
				) : (
					<table className="table">
						<thead>
							<tr>
								<th>id</th>
								<th>issued</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{credentials.map((record) => (
								<tr key={record.id}>
									<td className="mono">{record.id}</td>
									<td>{new Date(record.createdAt).toLocaleString()}</td>
									<td>
										<button
											type="button"
											className="button ghost danger-text"
											disabled={action.pending}
											onClick={() =>
												void action.run(async () => {
													await actions.revokeCredential(record.id);
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
			</div>

			{minted === undefined ? null : <Once label={minted.label} value={minted.value} />}

			<footer className="card-foot">
				{confirmDelete ? (
					<span className="row-inline">
						<span>Remove {connector.name} from the file?</span>
						<button
							type="button"
							className="button danger"
							disabled={action.pending}
							onClick={() =>
								void action.run(async () => {
									await actions.remove(connector.name);
									await refresh();
								})
							}
						>
							Remove it
						</button>
						<button type="button" className="button ghost" onClick={() => setConfirmDelete(false)}>
							Keep it
						</button>
					</span>
				) : (
					<button type="button" className="button ghost danger-text" onClick={() => setConfirmDelete(true)}>
						Remove this connector
					</button>
				)}
				<span className="faint">Saving writes the file; connectors are read at boot.</span>
			</footer>
		</Card>
	);
}

function CreateConnector({
	actions,
	refresh,
}: {
	readonly actions: ConnectorActions;
	readonly refresh: () => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [toolsUrl, setToolsUrl] = useState("");
	const [description, setDescription] = useState("");
	const action = useAction();
	return (
		<Card title="Add a connector" note="A name, and either an MCP endpoint or nothing but a grant to fill in.">
			<ErrorNote error={action.error} />
			<div className="create-grid">
				<Field label="name" hint="Lowercase letters, digits and dashes.">
					<input value={name} className="mono" onChange={(event) => setName(event.currentTarget.value)} />
				</Field>
				<Field label="tools url" hint="An MCP endpoint. Empty creates a connector with no tools face.">
					<input
						value={toolsUrl}
						placeholder="http://mason-slack:8082/mcp"
						className="mono"
						onChange={(event) => setToolsUrl(event.currentTarget.value)}
					/>
				</Field>
				<Field label="description" hint="The one line the model is told about its tools.">
					<input
						value={description}
						placeholder="Slack messages and threads"
						onChange={(event) => setDescription(event.currentTarget.value)}
					/>
				</Field>
				<div className="create-action">
					<button
						type="button"
						className="button primary"
						disabled={
							action.pending || name.trim() === "" || (toolsUrl.trim() !== "" && description.trim() === "")
						}
						onClick={() =>
							void action.run(async () => {
								await actions.create(name.trim(), toolsUrl.trim(), description.trim());
								setName("");
								setToolsUrl("");
								setDescription("");
								await refresh();
							})
						}
					>
						Add
					</button>
				</div>
			</div>
		</Card>
	);
}

export function Connectors({
	config,
	credentials,
	actions,
	refresh,
}: {
	readonly config: Config;
	readonly credentials: readonly { id: string; connector: string; createdAt: string }[];
	readonly actions: ConnectorActions;
	readonly refresh: () => Promise<void>;
}) {
	return (
		<div className="stack">
			{config.connectors.length === 0 ? (
				<Card title="Connectors">
					<p className="empty">No integrations are configured in this home yet.</p>
				</Card>
			) : (
				config.connectors.map((connector) => (
					<ConnectorCard
						key={`${connector.name}:${JSON.stringify(connector)}`}
						connector={connector}
						health={config.health.find((entry) => entry.name === connector.name)}
						config={config}
						credentials={credentials.filter((record) => record.connector === connector.name)}
						actions={actions}
						refresh={refresh}
					/>
				))
			)}
			<CreateConnector actions={actions} refresh={refresh} />
		</div>
	);
}
