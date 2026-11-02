/**
 * The operator panel's server: one grant-gated API for the things a person administers by hand.
 *
 * The panel itself is a browser application (`src/web/admin/`), and this file is the whole of what it can do. Two rules
 * shape it, both from `docs/SPEC.md` §4.5 and #99's decisions:
 *
 * 1. **Conversation and administration are different powers.** A device's grants (`auth.ts`) decide which keys its
 *    `/api/admin/state` answer carries and which writes it may make. Administration never implies the trace, and the
 *    trace never implies writing anything: the keys an ungranted device does not have are absent from the response,
 *    not filtered by the browser.
 * 2. **An answer still goes through the gateway.** Nothing here decides a tool call. The approvals route answers a
 *    question the gateway asked (`permissions.ts`), with the same first-answer-wins rule, and records the person the
 *    device speaks for — or `owner`, because the credential is the identity when a browser never joined as a name.
 *
 * The file writes are the commands' writers, not a second implementation: `writeIntegration`, `removeIntegration`,
 * `mintConnectorCredential`, `mintToken` and `addPerson` are what `npm run integration`, `connector`, `token` and
 * `team` already call. `/api/*` is the owner's per request (`auth.ts`), so an edit is live where the file is read per
 * request and "restart to apply" where the boot froze it: `integrations.json` is the boot's, and the state says so
 * with `restartRequired` rather than pretending a saved change is a running one.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CAPABILITIES, STATE_SCOPES } from "@mason/protocol";
import type {
	ConnectorGrantInput,
	ConnectorPatch,
	OperatorGrant,
	PanelConnector,
	PanelHealth,
	PanelPermission,
	PanelPerson,
	PanelState,
	PanelToken,
} from "../shared/admin.ts";
import { grantsOf, hasGrant, OPERATOR_GRANTS } from "../shared/admin.ts";
import { mintToken, revokeToken, setTokenGrants, type TokenRecord, type TokenStore } from "./auth.ts";
import {
	type ConnectorGrant,
	listConnectorCredentials,
	mintConnectorCredential,
	revokeConnectorCredential,
} from "./connectors.ts";
import { COMMAND_NAMES, isCommandName } from "./events.ts";
import type { HousePaths } from "./house.ts";
import { integrationSummaries } from "./integration-status.ts";
import {
	currentIntegrations,
	type Integration,
	readIntegrations,
	removeIntegration,
	writeIntegration,
} from "./integrations.ts";
import { JSON_BODY_MAX_BYTES, parseJsonObject, readBodyCapped } from "./limits.ts";
import { projectQueued, projectTranscript } from "./projection.ts";
import { addPerson, readRoster, removePerson } from "./roster.ts";
import type { AgentRuntime } from "./runtime.ts";
import { deriveAgentStatus } from "./status.ts";
import { projectTrace } from "./trace.ts";

/** An error the panel is meant to read: the status and the sentence a person can act on. */
export class PanelError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface OperatorDeps {
	readonly runtime: AgentRuntime;
	readonly house: HousePaths;
	readonly store: TokenStore;
	/** The credential the request presented. Grants are read from it per request, so a narrowing lands immediately. */
	readonly device: TokenRecord;
	/** The roster name the browser joined as, when it did. The approval answer is recorded under it. */
	readonly person?: string;
}

/** The request methods the panel uses. `PUT` for a connector (the whole editable surface) and `PATCH` for one field set. */
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Handle a request under `/api/admin/` (and the two approval endpoints the old console used), or answer `false` so the
 * caller can keep routing. Behind the owner's gate already: this file decides what the *granted device* may know.
 */
export async function handleOperatorRequest(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	deps: OperatorDeps,
): Promise<boolean> {
	const method = request.method ?? "GET";
	if (!METHODS.has(method)) {
		json(response, 405, { error: "method not allowed" });
		return true;
	}
	const grants = grantsOf(deps.device);
	try {
		if (url.pathname === "/api/permissions" || url.pathname.startsWith("/api/permissions/")) {
			await handlePermissions(request, response, url, deps, grants);
			return true;
		}
		if (!url.pathname.startsWith("/api/admin/")) return false;
		const segments = segmentsOf(url.pathname);
		await handleAdmin(request, response, segments, deps, grants);
		return true;
	} catch (error) {
		if (error instanceof PanelError) {
			json(response, error.status, { error: error.message });
			return true;
		}
		// A validation refusal from `integrations.ts` is the operator's message, not a stack trace: the file names the
		// path and the entry, which is what a person has to fix. Anything else is a server bug and keeps its 500.
		if (isOperatorFacing(error)) {
			json(response, 400, { error: error.message });
			return true;
		}
		throw error;
	}
}

/**
 * Whether an error is one the panel should show verbatim: the config readers' refusals name the path and the entry,
 * and they all phrase it the same way (`<path>: integration "<name>" …`). A `PanelError` never reaches this.
 */
function isOperatorFacing(error: unknown): error is Error {
	if (!(error instanceof Error)) return false;
	return /: integration "[a-z0-9-]*" /.test(error.message) || /is not JSON|has no "integrations"/.test(error.message);
}

async function handleAdmin(
	request: IncomingMessage,
	response: ServerResponse,
	segments: readonly string[],
	deps: OperatorDeps,
	grants: readonly OperatorGrant[],
): Promise<void> {
	const method = request.method ?? "GET";
	const [area, name, action] = segments;

	if (area === "state" && segments.length === 1) {
		requireMethod(method, "GET");
		json(response, 200, await panelState(deps, grants));
		return;
	}

	if (area === "connectors") {
		requireGrant(grants, "admin");
		if (name === undefined) {
			if (method !== "POST") throw new PanelError(405, "POST a connector to create one");
			json(response, 200, await createConnector(request, deps));
			return;
		}
		if (action === "credential" && method === "POST") {
			json(response, 200, await mintCredential(request, deps, name));
			return;
		}
		if (action === "trigger") {
			if (method === "POST") {
				json(response, 200, await mintTrigger(request, deps, name));
				return;
			}
			if (method === "DELETE") {
				json(response, 200, await removeTrigger(deps, name));
				return;
			}
			throw new PanelError(405, "POST or DELETE a trigger");
		}
		if (method === "PUT" || method === "PATCH") {
			json(response, 200, await patchConnector(request, deps, name));
			return;
		}
		if (method === "DELETE") {
			if (!(await removeIntegration(deps.house, name))) throw new PanelError(404, `no connector "${name}"`);
			json(response, 200, { removed: name, restartRequired: true });
			return;
		}
		throw new PanelError(405, "GET /api/admin/state lists connectors; PUT, DELETE, or a sub-route acts on one");
	}

	if (area === "credentials" && name !== undefined) {
		requireGrant(grants, "admin");
		requireMethod(method, "DELETE");
		if (!(await revokeConnectorCredential(deps.house.home, name))) throw new PanelError(404, `no credential ${name}`);
		json(response, 200, { revoked: name });
		return;
	}

	if (area === "tokens") {
		requireGrant(grants, "admin");
		if (name === undefined && method === "POST") {
			json(response, 200, await mintDevice(request, deps));
			return;
		}
		if (name === undefined) throw new PanelError(405, "POST a token to mint one");
		if (method === "PATCH") {
			const body = await bodyOf(request);
			const wanted = grantsFrom(body.grants);
			const record = await setTokenGrants(deps.house.home, name, wanted);
			if (record === undefined) throw new PanelError(404, `no token ${name}`);
			json(response, 200, tokenWire(record));
			return;
		}
		if (method === "DELETE") {
			if (!(await revokeToken(deps.house.home, name))) throw new PanelError(404, `no token ${name}`);
			json(response, 200, { revoked: name });
			return;
		}
		throw new PanelError(405, "PATCH a token's grants or DELETE it");
	}

	if (area === "roster") {
		requireGrant(grants, "admin");
		if (name === undefined && method === "POST") {
			const body = await bodyOf(request);
			if (typeof body.name !== "string") throw new PanelError(400, 'the body is {"name":"Ilya"}');
			const added = await addPerson(deps.house, body.name);
			if (!added.ok) {
				throw new PanelError(
					added.reason === "duplicate" ? 409 : 400,
					added.reason === "duplicate"
						? `${body.name} is already on the roster`
						: `${body.name} is not a name the roster can carry`,
				);
			}
			json(response, 200, { name: added.person.name, addedAt: added.person.addedAt });
			return;
		}
		if (name === undefined) throw new PanelError(405, "POST a name to add a person");
		if (method === "DELETE") {
			if (!(await removePerson(deps.house, name))) throw new PanelError(404, `${name} is not on the roster`);
			json(response, 200, { removed: name });
			return;
		}
		throw new PanelError(405, "DELETE a person to remove them");
	}

	if (area === "hooks" && name !== undefined) {
		requireGrant(grants, "admin");
		if (action === "fire" && method === "POST") {
			if (!deps.runtime.hooks.has(name)) throw new PanelError(404, `no hook ${name}`);
			// Pressing fire is a gesture: no request id, so each press is its own fire.
			const submission = await deps.runtime.hooks.fire(name, {});
			json(response, 200, { submissionId: String(submission.id) });
			return;
		}
		if (method === "PATCH") {
			const body = await bodyOf(request);
			if (typeof body.enabled !== "boolean") throw new PanelError(400, 'the body is {"enabled":true}');
			if (!deps.runtime.hooks.has(name)) throw new PanelError(404, `no hook ${name}`);
			const hook = deps.runtime.hooks.setEnabled(name, body.enabled);
			json(response, 200, { id: hook.id, enabled: hook.enabled });
			return;
		}
		throw new PanelError(405, "PATCH a hook's switch or POST .../fire");
	}

	if (area === "control" && name === undefined) {
		requireMethod(method, "POST");
		const body = await bodyOf(request);
		json(response, 200, await control(body, deps, grants));
		return;
	}

	throw new PanelError(404, "no such panel route");
}

/** One state answer, holding a key only for a grant this device has. */
async function panelState(deps: OperatorDeps, grants: readonly OperatorGrant[]): Promise<PanelState> {
	const view = await deps.runtime.viewSnapshot(BACKGROUND_CONTEXT);
	const session = {
		device: { id: deps.device.id, label: deps.device.label },
		...(deps.person === undefined ? {} : { person: deps.person }),
		grants,
	};
	return {
		now: new Date().toISOString(),
		session,
		...(hasGrant(grants, "conversation")
			? {
					conversation: {
						status: deriveAgentStatus(view, {
							hooks: deps.runtime.hooks.list(),
							model: deps.runtime.model,
							cwd: deps.runtime.workspaceDir,
						}),
						transcript: projectTranscript(view),
						queued: projectQueued(view),
					},
				}
			: {}),
		// The raw view is a grant of its own: a device with the conversation is not sent the trace, and no key here is
		// a placeholder the browser could mistake for "empty".
		...(hasGrant(grants, "trace") ? { trace: projectTrace(view) } : {}),
		...(hasGrant(grants, "approve") ? { permissions: await pendingPermissions(deps.runtime) } : {}),
		...(hasGrant(grants, "admin") ? { config: await panelConfig(deps) } : {}),
	};
}

async function panelConfig(deps: OperatorDeps): Promise<NonNullable<PanelState["config"]>> {
	const file = (await readIntegrations(deps.house)).integrations;
	const booted = currentIntegrations();
	const roster = await readRoster(deps.house);
	return {
		connectors: Object.keys(file)
			.sort()
			.map((name) => connectorWire(name, file[name])),
		health: integrationSummaries(booted) as PanelHealth[],
		roster: roster.people.map((person): PanelPerson => ({ name: person.name, addedAt: person.addedAt })),
		tokens: (await deps.store.records()).map(tokenWire),
		credentials: (await listConnectorCredentials(deps.house.home)).map((record) => ({
			id: record.id,
			connector: record.connector,
			createdAt: record.createdAt,
		})),
		hooks: deps.runtime.hooks.list(),
		commands: [...COMMAND_NAMES],
		capabilities: [...CAPABILITIES],
		stateScopes: [...STATE_SCOPES],
		restartRequired: JSON.stringify(file) !== JSON.stringify(booted),
		grants: OPERATOR_GRANTS,
	};
}

function tokenWire(record: TokenRecord): PanelToken {
	return {
		id: record.id,
		label: record.label,
		createdAt: record.createdAt,
		grants: grantsOf(record),
	};
}

/** One entry as the panel edits it. The trigger's secret and the tools credential are named as present, never sent. */
function connectorWire(name: string, entry: Integration): PanelConnector {
	const grant = entry.connector;
	return {
		name,
		enabled: entry.enabled,
		description: entry.description ?? null,
		tools:
			entry.tools === undefined
				? null
				: {
						url: entry.tools.url,
						required: entry.tools.required === true,
						hasCredential: entry.tools.credential !== undefined,
					},
		trigger: entry.trigger === undefined ? null : { hook: entry.trigger.hook },
		connector: grant === undefined ? null : grantWire(grant),
		commands: entry.commands ?? [],
	};
}

function grantWire(grant: ConnectorGrant): NonNullable<PanelConnector["connector"]> {
	return {
		...(grant.user === undefined
			? {}
			: {
					user: {
						actors: grant.user.actors,
						conversations: grant.user.conversations,
						...(grant.user.capabilities === undefined ? {} : { capabilities: grant.user.capabilities }),
						unattributed: grant.user.unattributed,
						...(grant.user.approver === undefined ? {} : { approver: grant.user.approver }),
					},
				}),
		...(grant.events === undefined ? {} : { events: { hooks: grant.events.hooks } }),
		state: grant.state,
		trustMarkers: grant.trustMarkers,
		...(grant.policy === undefined ? {} : { policy: grant.policy }),
	};
}

async function createConnector(request: IncomingMessage, deps: OperatorDeps): Promise<unknown> {
	const body = await bodyOf(request);
	const name = body.name;
	if (typeof name !== "string") throw new PanelError(400, 'the body is {"name":"github", …}');
	const existing = (await readIntegrations(deps.house)).integrations[name];
	if (existing !== undefined) throw new PanelError(409, `"${name}" already exists`);
	const entry = entryFromPatch(name, undefined, body as ConnectorPatch);
	const written = await writeIntegration(deps.house, name, entry);
	return { connector: connectorWire(name, written), restartRequired: true };
}

async function patchConnector(request: IncomingMessage, deps: OperatorDeps, name: string): Promise<unknown> {
	const body = await bodyOf(request);
	const existing = (await readIntegrations(deps.house)).integrations[name];
	if (existing === undefined) throw new PanelError(404, `no connector "${name}"`);
	const entry = entryFromPatch(name, existing, body as ConnectorPatch);
	const written = await writeIntegration(deps.house, name, entry);
	return { connector: connectorWire(name, written), restartRequired: true };
}

/**
 * Merge one patch into one entry.
 *
 * The rule is "an absent key is left alone, `null` removes": the panel sends what the operator changed, not a whole
 * file, so two pages that edit different faces of one connector cannot delete each other's work. Every key mason does
 * not know survives — the same promise `writeIntegration` makes for the file.
 */
function entryFromPatch(name: string, existing: Integration | undefined, patch: ConnectorPatch): Integration {
	if (existing === undefined && patch.tools === undefined && patch.connector === undefined) {
		throw new PanelError(400, `"${name}" needs a tools face or a connector block: an entry with neither is nothing`);
	}
	const next: Record<string, unknown> = { ...(existing ?? { enabled: true }) };
	if (patch.enabled !== undefined) next.enabled = patch.enabled;
	if (patch.description !== undefined) next.description = patch.description;
	if (patch.tools !== undefined) {
		if (patch.tools === null) {
			delete next.tools;
		} else {
			const previous = (existing?.tools ?? {}) as { credential?: string };
			const credential =
				patch.tools.credential !== undefined && patch.tools.credential !== ""
					? patch.tools.credential
					: previous.credential;
			next.tools = {
				...previous,
				url: patch.tools.url,
				...(patch.tools.required === undefined ? {} : { required: patch.tools.required }),
				...(credential === undefined ? {} : { credential }),
			};
		}
	}
	if (patch.connector !== undefined) {
		if (patch.connector === null) delete next.connector;
		else next.connector = grantFromInput(patch.connector, existing?.connector);
	}
	if (patch.commands !== undefined) {
		for (const word of patch.commands) {
			if (!isCommandName(word)) {
				throw new PanelError(
					400,
					`"${word}" is not a command mason has: the whole set is ${COMMAND_NAMES.join(", ")}`,
				);
			}
		}
		next.commands = [...patch.commands];
	}
	return next as unknown as Integration;
}

/** The connector block's own merge. `null` removes a face or a key; an absent one is left as it was. */
function grantFromInput(input: ConnectorGrantInput, existing: ConnectorGrant | undefined): Record<string, unknown> {
	const previous = (existing ?? {}) as unknown as Record<string, unknown>;
	const next: Record<string, unknown> = { ...previous };
	if (input.user !== undefined) {
		if (input.user === null) {
			delete next.user;
		} else {
			const user = { ...((previous.user ?? {}) as Record<string, unknown>) };
			const patch = input.user;
			if (patch.actors !== undefined) user.actors = patch.actors;
			if (patch.conversations !== undefined) user.conversations = patch.conversations;
			if (patch.unattributed !== undefined) user.unattributed = patch.unattributed;
			if (patch.capabilities === null) delete user.capabilities;
			else if (patch.capabilities !== undefined) user.capabilities = patch.capabilities;
			if (patch.approver === null) delete user.approver;
			else if (patch.approver !== undefined) user.approver = patch.approver;
			next.user = user;
		}
	}
	if (input.events !== undefined) {
		if (input.events === null) {
			delete next.events;
		} else {
			const events = { ...((previous.events ?? {}) as Record<string, unknown>) };
			if (input.events.hooks !== undefined) events.hooks = input.events.hooks;
			next.events = events;
		}
	}
	if (input.state !== undefined) next.state = input.state;
	if (input.trustMarkers !== undefined) next.trustMarkers = input.trustMarkers;
	if (input.policy !== undefined) {
		if (input.policy === null) {
			delete next.policy;
		} else {
			const policy = { ...((previous.policy ?? {}) as Record<string, unknown>) };
			// An empty list is a rule that matches nothing, which is how a rule list is taken away without deleting the key.
			if (input.policy.allow !== undefined) policy.allow = input.policy.allow;
			if (input.policy.ask !== undefined) policy.ask = input.policy.ask;
			if (input.policy.deny !== undefined) policy.deny = input.policy.deny;
			next.policy = policy;
		}
	}
	return next;
}

/**
 * One credential for one connector. `replace` rotates: the entry's other credentials are dropped in the same write, so
 * a leaked one stops opening a socket at the next connection. Printed once, here, and never again.
 */
async function mintCredential(request: IncomingMessage, deps: OperatorDeps, name: string): Promise<unknown> {
	const body = await bodyOf(request);
	const existing = (await readIntegrations(deps.house)).integrations[name];
	if (existing === undefined) throw new PanelError(404, `no connector "${name}"`);
	if (existing.connector === undefined) {
		throw new PanelError(
			400,
			`"${name}" declares no connector block, so a credential would open a socket with no face on it`,
		);
	}
	const { credential, record } = await mintConnectorCredential(deps.house.home, name, {
		replace: body.replace === true,
	});
	return { id: record.id, credential };
}

/**
 * A trigger face is minted, never typed: the secret is 32 bytes mason makes, and adding a trigger and rotating one are
 * the same act. The hook it fires must be one this build has, because a trigger to a hook nobody defines is a door
 * that answers nothing.
 */
async function mintTrigger(request: IncomingMessage, deps: OperatorDeps, name: string): Promise<unknown> {
	const body = await bodyOf(request);
	const hook = body.hook;
	if (typeof hook !== "string" || hook.trim() === "") throw new PanelError(400, 'the body is {"hook":"<hook id>"}');
	if (!deps.runtime.hooks.has(hook)) {
		const known = deps.runtime.hooks.list().map((entry) => entry.id);
		throw new PanelError(400, `"${hook}" is not a hook this build has: ${known.join(", ") || "none are defined"}`);
	}
	const existing = (await readIntegrations(deps.house)).integrations[name];
	if (existing === undefined) throw new PanelError(404, `no connector "${name}"`);
	const secret = mintSecret();
	await writeIntegration(deps.house, name, {
		...existing,
		trigger: { ...(existing.trigger ?? {}), hook, secret },
	});
	return { hook, secret, restartRequired: true };
}

function mintSecret(): string {
	return randomBytes(32).toString("hex");
}

async function removeTrigger(deps: OperatorDeps, name: string): Promise<unknown> {
	const existing = (await readIntegrations(deps.house)).integrations[name];
	if (existing === undefined) throw new PanelError(404, `no connector "${name}"`);
	if (existing.trigger === undefined) throw new PanelError(400, `"${name}" has no trigger`);
	const { trigger: _removed, ...rest } = existing;
	await writeIntegration(deps.house, name, rest as Integration);
	return { removed: name, restartRequired: true };
}

/** Mint a device. The token is in this response and nowhere else — the file holds a hash. */
async function mintDevice(request: IncomingMessage, deps: OperatorDeps): Promise<unknown> {
	const body = await bodyOf(request);
	const label = typeof body.label === "string" ? body.label : "device";
	const grants = grantsFrom(body.grants);
	const minted = await mintToken(deps.house.home, label, grants);
	return { id: minted.record.id, token: minted.token, label: minted.record.label, grants: grantsOf(minted.record) };
}

function grantsFrom(value: unknown): OperatorGrant[] {
	if (value === undefined) return ["conversation"];
	if (!Array.isArray(value)) throw new PanelError(400, 'grants are a list, e.g. ["conversation"]');
	const grants: OperatorGrant[] = [];
	for (const entry of value) {
		if (!OPERATOR_GRANTS.includes(entry as OperatorGrant)) {
			throw new PanelError(400, `"${String(entry)}" is not a grant: the whole set is ${OPERATOR_GRANTS.join(", ")}`);
		}
		grants.push(entry as OperatorGrant);
	}
	return grants;
}

/** The controls the console used to offer. `stop` and `compact` are conversation powers; `clear` loses context. */
async function control(
	body: Record<string, unknown>,
	deps: OperatorDeps,
	grants: readonly OperatorGrant[],
): Promise<unknown> {
	const action = body.action;
	const conversation = await deps.runtime.conversation();
	if (action === "stop") {
		requireGrant(grants, "conversation");
		await conversation.abort(BACKGROUND_CONTEXT);
		return { action, done: true };
	}
	if (action === "compact") {
		requireGrant(grants, "conversation");
		await conversation.compact(
			typeof body.instructions === "string" ? body.instructions : undefined,
			BACKGROUND_CONTEXT,
		);
		return { action, done: true };
	}
	if (action === "clear") {
		requireGrant(grants, "admin");
		await conversation.reset(typeof body.handoff === "string" ? body.handoff : undefined, BACKGROUND_CONTEXT);
		return { action, done: true };
	}
	throw new PanelError(400, 'the body is {"action":"stop"}, "compact" or "clear"');
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* The permission question                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

async function handlePermissions(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	deps: OperatorDeps,
	grants: readonly OperatorGrant[],
): Promise<void> {
	requireGrant(grants, "approve");
	const method = request.method ?? "GET";
	if (url.pathname === "/api/permissions") {
		requireMethod(method, "GET");
		json(response, 200, { permissions: await pendingPermissions(deps.runtime) });
		return;
	}
	if (method !== "POST") throw new PanelError(405, "POST an answer");
	// A malformed escape is a junk id, not a broken server: `decodeURIComponent` throws on `%zz`.
	let permissionId: string;
	try {
		permissionId = decodeURIComponent(url.pathname.slice("/api/permissions/".length));
	} catch {
		throw new PanelError(404, "no such request");
	}
	if (permissionId === "") throw new PanelError(404, "no such request");
	const body = await bodyOf(request);
	if (body.answer !== "allow" && body.answer !== "deny") {
		throw new PanelError(400, 'the body is {"answer":"allow"} or {"answer":"deny"}');
	}
	const found = await deps.runtime.permissions.find(permissionId);
	if (found.request === undefined) throw new PanelError(404, "no such request");
	// The credential is the identity: a device that joined as a name is recorded under it, and one that never joined
	// answers as `owner`. The gateway, not this route, decides whether the answer is in time.
	const settled = await deps.runtime.permissions.answer(permissionId, body.answer, deps.person ?? "owner");
	json(response, settled.settled ? 200 : 409, settled);
}

async function pendingPermissions(runtime: AgentRuntime): Promise<PanelPermission[]> {
	const pending = await runtime.permissions.pending();
	return pending.map((request) => ({
		permissionId: request.permissionId,
		tool: request.tool,
		arguments: request.arguments ?? null,
		reason: request.reason,
		answers: request.answers,
		approver: request.approver ?? null,
		origin: request.origin ?? null,
		askedAt: request.askedAt === 0 ? null : new Date(request.askedAt).toISOString(),
	}));
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Small things                                                                                                     */
/* ---------------------------------------------------------------------------------------------------------------- */

function segmentsOf(pathname: string): string[] {
	return pathname
		.slice("/api/admin/".length)
		.split("/")
		.filter((segment) => segment !== "")
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				throw new PanelError(404, "no such panel route");
			}
		});
}

/** A refusal a granted device never sees, and an ungranted one cannot talk its way past. */
function requireGrant(grants: readonly OperatorGrant[], grant: OperatorGrant): void {
	if (hasGrant(grants, grant)) return;
	throw new PanelError(403, `this device has no "${grant}" grant`);
}

function requireMethod(method: string, wanted: string): void {
	if (method === wanted) return;
	throw new PanelError(405, `use ${wanted}`);
}

/** A JSON body, or `{}` for one that is empty. Over the cap is a `413`, before anything is parsed. */
async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
	const text = await readBodyCapped(request, JSON_BODY_MAX_BYTES);
	if (text === undefined) throw new PanelError(413, `that body is over ${JSON_BODY_MAX_BYTES} bytes`);
	return parseJsonObject(text);
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
	response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}
