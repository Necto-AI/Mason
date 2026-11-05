/**
 * Connectors: the grants a service holds, and the credential it opens its socket with.
 *
 * A connector is one external process with up to three faces — it carries people's words, lends tools, reports events —
 * and it is the same entry in `service/integrations.json` that already described a tools endpoint and a trigger. The
 * `connector` block is what the operator grants it: which external actor is the owner's, which external conversations may
 * be spoken in, which event kinds fire which hook, which state scopes it may mirror, which controls it may spend on
 * `mason/control`, and whether its approval markers may waive approval.
 *
 * Everything here is a **ceiling**, never a wish. The connector advertises its faces at the handshake and the answer is
 * the intersection with this file: an actor that is not the owner is refused, a conversation that is not listed is refused,
 * a kind that maps to no hook is refused, a scope that is not granted is refused. A face the entry does not grant is
 * named in `inactive` with a reason rather than dropped, because a connector silently missing half its behaviour is the
 * bug nobody finds.
 *
 * The file is validated where every integration is validated (`integrations.ts`), so a grant that cannot work refuses
 * the boot instead of leaving a connector with fewer powers than its operator believes it has.
 *
 * ## The credential
 *
 * Mason issues one credential per connector. It is stored as a SHA-256 hash in `service/config.json` — beside the
 * browser tokens and for the same reason, that file ends up in bug reports — and read on every upgrade request, so a
 * revoke lands on the next connection rather than on the next restart. It is **not** an owner token: it opens
 * `/api/connector` and the attachment endpoints, and nothing else. A connector never receives the owner's token, and
 * the connector's own credential for mason's MCP calls is configured on the tools face (`tools.credential`), which is
 * the other direction and never leaves the server except on that call.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
	CAPABILITIES,
	type Capability,
	CONTROL_OPS,
	type ControlOp,
	type ExternalActor,
	type ExternalConversation,
	STATE_SCOPES,
	type StateScope,
} from "mason-protocol";
import { originAllowed, readConfig, writeConfig } from "./auth.ts";
import type { Integration } from "./integrations.ts";

/** A leaked connector credential is recognisable in a log, and distinct from an owner token at a glance. */
const CONNECTOR_PREFIX = "masonc_";

/**
 * The user face as the operator granted it: the owner, the rooms, and the content it may claim.
 *
 * One person, one bot: the grant names the single external actor whose words are the owner's, and every other actor is
 * refused. Absent means the connector may carry words nobody attributed — a notice, a forwarded thing — and no voice.
 */
export interface ConnectorUserGrant {
	/** The external actor id that speaks for the person this bot works for. */
	readonly owner?: string;
	readonly conversations: readonly ExternalConversation[];
	/** The content this connector may claim, when the operator narrowed it. Absent means "whatever it advertises". */
	readonly capabilities?: readonly Capability[];
}

/** The events face: the operator's `kind` → hook map. A kind absent from it is refused. */
export interface ConnectorEventGrant {
	readonly hooks: Readonly<Record<string, string>>;
}

/** One connector's grants, as `integrations.json` holds them. */
export interface ConnectorGrant {
	readonly user?: ConnectorUserGrant;
	readonly events?: ConnectorEventGrant;
	/** The state scopes this connector may subscribe to. A scope absent from here is refused, not narrowed. */
	readonly state: readonly StateScope[];
	/**
	 * The controls this connector's socket may spend on `mason/control`, out of the protocol's closed vocabulary. Absent
	 * or empty is no vocabulary at all: a chat that was never granted `stop` is a chat that cannot interrupt a turn, and
	 * saying so at the handshake's first refusal is better than a word that silently never runs.
	 */
	readonly commands?: readonly ControlOp[];
	/**
	 * Whether this connector's `dev.mason/approval` markers may waive approval. Off unless the operator says so: a
	 * connector describes its own operations, and trusting that description is a decision only the operator makes.
	 */
	readonly trustMarkers: boolean;
	/**
	 * The operator's own rules for this connector's tools, each naming a tool as the server does (`issues.create`) or
	 * `*` for every tool on the connector. `deny` beats `ask` beats `allow`, so a rule can only tighten what a marker
	 * says: `required` asks unless a deny rule refuses it, and `not_required` allows only with an allow rule or trusted
	 * markers.
	 */
	readonly policy?: ConnectorPolicy;
}

/** The three rule lists, all of them optional: an absent list is no rule. */
export interface ConnectorPolicy {
	readonly allow?: readonly string[];
	readonly ask?: readonly string[];
	readonly deny?: readonly string[];
}

/** One issued connector credential, as `config.json` holds it. The credential itself exists only in the hand that got it. */
export interface ConnectorCredential {
	readonly id: string;
	/** The integration entry it speaks for. */
	readonly connector: string;
	/** SHA-256 of the credential, hex. Never the credential. */
	readonly sha256: string;
	readonly createdAt: string;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

function refusal(where: string, name: string, message: string): string {
	return `${where}: integration "${name}" ${message}`;
}

/**
 * One entry's `connector` block, checked and normalised, or `undefined` when the entry declares no connector.
 *
 * A block with no face at all is refused: it would issue a credential that opens a socket with nothing on it, which is
 * the shape of a half-finished configuration nobody notices until the connector asks why it is silent.
 */
export function readConnectorGrant(
	where: string,
	name: string,
	value: unknown,
	hasToolsFace: boolean,
): ConnectorGrant | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has a "connector" that is not an object'));
	}
	const raw = value as Record<string, unknown>;
	const user = readUser(where, name, raw.user);
	const events = readEvents(where, name, raw.events);
	const state = readState(where, name, raw.state);
	const commands = readCommands(where, name, raw.commands);
	const trustMarkers = readBoolean(where, name, raw, "trustMarkers");
	const policy = readPolicy(where, name, raw.policy);
	const hasFace = user !== undefined || events !== undefined || hasToolsFace;
	if (!hasFace) {
		throw new Error(
			refusal(
				where,
				name,
				'has a "connector" that grants no face: a user face, an events face or a tools face (the entry\'s own ' +
					'"tools") is what a connector is',
			),
		);
	}
	return {
		...(user === undefined ? {} : { user }),
		...(events === undefined ? {} : { events }),
		state,
		...(commands === undefined ? {} : { commands }),
		trustMarkers,
		...(policy === undefined ? {} : { policy }),
	};
}

/**
 * The controls this grant may spend. The names are the protocol's own closed set, so a typo is refused here with the
 * whole set in the message: a command an operator believes they granted and that silently never runs is the quiet loss
 * this file is shaped against.
 */
function readCommands(where: string, name: string, value: unknown): ControlOp[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(
			refusal(where, name, 'has a "connector.commands" that is not a list: the controls this socket may spend'),
		);
	}
	const commands: ControlOp[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !(CONTROL_OPS as readonly string[]).includes(entry)) {
			throw new Error(
				refusal(
					where,
					name,
					`grants the control ${typeof entry === "string" ? `"${entry}"` : JSON.stringify(entry)}, which mason ` +
						`does not have: the whole set is ${CONTROL_OPS.join(", ")}`,
				),
			);
		}
		commands.push(entry as ControlOp);
	}
	return commands;
}

/**
 * The keys a user face carried when mason kept a room: a mapping, an escape hatch for strangers, and a named approver.
 *
 * They are refused rather than ignored. A file that still says who may speak is a file whose reader believes it still
 * decides that, and the one sentence that moves it is the doctor's.
 */
const RETIRED_USER_KEYS = ["actors", "unattributed", "approver"] as const;

function readUser(where: string, name: string, value: unknown): ConnectorUserGrant | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has a "connector.user" that is not an object'));
	}
	const raw = value as Record<string, unknown>;
	const retired = RETIRED_USER_KEYS.filter((key) => raw[key] !== undefined);
	if (retired.length > 0) {
		throw new Error(
			refusal(
				where,
				name,
				`has a retired "connector.user.${retired[0]}": mason works for one person, so a user face names one ` +
					'"owner" actor and no mapping, no unattributed switch and no approver. Run `npm run doctor -- migrate` ' +
					"to rewrite it",
			),
		);
	}
	const conversations = readConversations(where, name, raw.conversations);
	const capabilities = readCapabilities(where, name, raw.capabilities);
	const owner = raw.owner;
	if (owner !== undefined && (typeof owner !== "string" || owner.trim() === "")) {
		throw new Error(
			refusal(
				where,
				name,
				'has a "connector.user.owner" that is not an actor id: it is the one actor mason accepts',
			),
		);
	}
	return {
		...(owner === undefined ? {} : { owner: owner as string }),
		conversations,
		...(capabilities === undefined ? {} : { capabilities }),
	};
}

function readConversations(where: string, name: string, value: unknown): ExternalConversation[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has a "connector.user.conversations" that is not a list'));
	}
	return value.map((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(refusal(where, name, `has a conversation ${index} that is not an object`));
		}
		const raw = entry as Record<string, unknown>;
		const id = raw.externalConversationId;
		if (typeof id !== "string" || id.trim() === "") {
			throw new Error(
				refusal(where, name, `has a conversation ${index} with no "externalConversationId": it is the room`),
			);
		}
		const kind = raw.kind;
		if (kind !== "person" && kind !== "room") {
			throw new Error(refusal(where, name, `has a conversation "${id}" whose "kind" is not "person" or "room"`));
		}
		const title = raw.title;
		if (title !== undefined && typeof title !== "string") {
			throw new Error(refusal(where, name, `has a conversation "${id}" with a "title" that is not a string`));
		}
		return { externalConversationId: id, kind, ...(title === undefined ? {} : { title }) };
	});
}

/**
 * The operator's narrowing of what the connector may claim it renders. Absent means the connector's own claim stands:
 * capabilities are not privileges, so an operator who has not thought about them is not silently given fewer than the
 * medium can do. A name mason does not know is a refusal, because it would otherwise be a wish nobody reads.
 */
function readCapabilities(where: string, name: string, value: unknown): Capability[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has a "connector.user.capabilities" that is not a list'));
	}
	const capabilities: Capability[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !(CAPABILITIES as readonly string[]).includes(entry)) {
			throw new Error(
				refusal(
					where,
					name,
					`declares the capability ${typeof entry === "string" ? `"${entry}"` : JSON.stringify(entry)}, which ` +
						`the protocol does not have: the whole set is ${CAPABILITIES.join(", ")}`,
				),
			);
		}
		capabilities.push(entry as Capability);
	}
	return capabilities;
}

function readEvents(where: string, name: string, value: unknown): ConnectorEventGrant | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has a "connector.events" that is not an object'));
	}
	const raw = (value as Record<string, unknown>).hooks;
	if (raw === undefined) return { hooks: {} };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(
			refusal(where, name, 'has a "connector.events.hooks" that is not an object mapping kinds to hook ids'),
		);
	}
	const hooks: Record<string, string> = {};
	for (const [kind, hook] of Object.entries(raw)) {
		if (kind.trim() === "") throw new Error(refusal(where, name, "maps an empty event kind to a hook"));
		if (typeof hook !== "string" || hook.trim() === "") {
			throw new Error(refusal(where, name, `maps the kind "${kind}" to no hook`));
		}
		hooks[kind] = hook.trim();
	}
	return { hooks };
}

function readState(where: string, name: string, value: unknown): StateScope[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has a "connector.state" that is not a list'));
	}
	const scopes: StateScope[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !(STATE_SCOPES as readonly string[]).includes(entry)) {
			throw new Error(
				refusal(
					where,
					name,
					`declares the state scope ${typeof entry === "string" ? `"${entry}"` : JSON.stringify(entry)}, which ` +
						`mason does not have: the whole set is ${STATE_SCOPES.join(", ")}`,
				),
			);
		}
		scopes.push(entry as StateScope);
	}
	return scopes;
}

/**
 * The operator's ask/deny/allow rules. Each is a list of tool names; an empty list is no rule, and a name is kept as the
 * server spells it. An unknown key inside `policy` is not refused — like every entry in this file, a key mason does not
 * know survives a rewrite, so a newer build's rule is not deleted by an older one.
 */
function readPolicy(where: string, name: string, value: unknown): ConnectorPolicy | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has a "connector.policy" that is not an object'));
	}
	const raw = value as Record<string, unknown>;
	const allow = readRuleList(where, name, raw.allow, "allow");
	const ask = readRuleList(where, name, raw.ask, "ask");
	const deny = readRuleList(where, name, raw.deny, "deny");
	if (allow === undefined && ask === undefined && deny === undefined) return undefined;
	return {
		...(allow === undefined ? {} : { allow }),
		...(ask === undefined ? {} : { ask }),
		...(deny === undefined ? {} : { deny }),
	};
}

function readRuleList(where: string, name: string, value: unknown, key: string): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(refusal(where, name, `has a "connector.policy.${key}" that is not a list of tool names`));
	}
	return value.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim() === "") {
			throw new Error(
				refusal(where, name, `has a "connector.policy.${key}" entry ${index} that is not a tool name`),
			);
		}
		return entry.trim();
	});
}

function readBoolean(where: string, name: string, raw: Record<string, unknown>, key: string): boolean {
	const value = raw[key];
	if (value === undefined) return false;
	if (typeof value !== "boolean") {
		throw new Error(refusal(where, name, `has a "${key}" that is not true or false`));
	}
	return value;
}

/** The enabled entry's grant, or `undefined` when the entry is absent, switched off or declares no connector. */
export function connectorGrantFor(
	integrations: Record<string, Integration>,
	name: string,
): { readonly integration: Integration; readonly grant: ConnectorGrant } | undefined {
	const integration = integrations[name];
	if (integration === undefined || !integration.enabled || integration.connector === undefined) return undefined;
	return { integration, grant: integration.connector };
}

/** Every enabled connector, in name order: what a boot iterates to check hooks and report health. */
export function enabledConnectors(
	integrations: Record<string, Integration>,
): Array<{ readonly name: string; readonly integration: Integration; readonly grant: ConnectorGrant }> {
	return Object.entries(integrations)
		.flatMap(([name, integration]) =>
			integration.enabled && integration.connector !== undefined
				? [{ name, integration, grant: integration.connector }]
				: [],
		)
		.sort((left, right) => (left.name < right.name ? -1 : 1));
}

/**
 * The one actor the handshake answers with: the advertised actor whose id is the grant's `owner`, as the connector
 * advertised it, or nothing.
 *
 * The wire stays a list because it always was one, and the answer stays the connector's own record — its own id, its own
 * display name — so mason never invents an actor the medium would not recognise. Empty means the connector advertised no
 * such id, and then every submission that names an actor is refused.
 */
export function grantedActors(user: ConnectorUserGrant, advertised: readonly ExternalActor[]): ExternalActor[] {
	if (user.owner === undefined) return [];
	const actor = advertised.find((candidate) => candidate.externalActorId === user.owner);
	return actor === undefined ? [] : [actor];
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Credentials                                                                                                       */
/* ---------------------------------------------------------------------------------------------------------------- */

function digest(credential: string): string {
	return createHash("sha256").update(credential, "utf8").digest("hex");
}

function isCredentialRecord(value: unknown): value is ConnectorCredential {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.connector === "string" &&
		typeof record.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(record.sha256) &&
		typeof record.createdAt === "string"
	);
}

/** Every connector credential this home has issued. Read per request, like the tokens, so a revoke is live. */
export async function listConnectorCredentials(home: string): Promise<readonly ConnectorCredential[]> {
	const config = await readConfig(home);
	const declared = config.connectors;
	return Array.isArray(declared) ? declared.filter(isCredentialRecord) : [];
}

export interface MintedConnectorCredential {
	readonly credential: string;
	readonly record: ConnectorCredential;
}

/**
 * Mint one credential for one connector. The plaintext is in the return value and nowhere else.
 *
 * `--replace` semantics belong to the caller: this appends, and a rotation is revoke-then-mint or a caller that passes
 * `replace`. The file is written atomically and privately by `auth.ts`, which owns its mode.
 */
export async function mintConnectorCredential(
	home: string,
	connector: string,
	options: { readonly replace?: boolean } = {},
): Promise<MintedConnectorCredential> {
	if (!NAME.test(connector)) throw new Error(`"${connector}" is not an integration name`);
	const config = await readConfig(home);
	const existing = await listConnectorCredentials(home);
	const credential = `${CONNECTOR_PREFIX}${randomBytes(32).toString("base64url")}`;
	const record: ConnectorCredential = {
		id: `con_${randomBytes(4).toString("hex")}`,
		connector,
		sha256: digest(credential),
		createdAt: new Date().toISOString(),
	};
	const kept = options.replace === true ? existing.filter((entry) => entry.connector !== connector) : existing;
	await writeConfig(home, { ...config, connectors: [...kept, record] });
	return { credential, record };
}

/** Remove one credential. `false` when no such id: a typo must not read as a successful revoke. */
export async function revokeConnectorCredential(home: string, id: string): Promise<boolean> {
	const config = await readConfig(home);
	const existing = await listConnectorCredentials(home);
	const remaining = existing.filter((record) => record.id !== id);
	if (remaining.length === existing.length) return false;
	await writeConfig(home, { ...config, connectors: remaining });
	return true;
}

/**
 * Which connector a presented credential speaks for, or `undefined`.
 *
 * Constant-time over every stored hash, and length-checked first: a wrong credential and a right-but-short one must cost
 * the same to reject. The connector named here is only a claim until the caller checks that its entry still exists and
 * is switched on — a credential for a removed connector opens nothing.
 */
export function verifyConnectorCredential(
	records: readonly ConnectorCredential[],
	presented: string | undefined,
): ConnectorCredential | undefined {
	if (presented === undefined || presented.length < CONNECTOR_PREFIX.length + 16) return undefined;
	const presentedDigest = Buffer.from(digest(presented), "hex");
	for (const record of records) {
		const stored = Buffer.from(record.sha256, "hex");
		if (stored.length === presentedDigest.length && timingSafeEqual(stored, presentedDigest)) return record;
	}
	return undefined;
}

/** The credential prefix, so a caller can refuse an owner token early instead of hashing it against the wrong list. */
export function isConnectorCredentialShape(value: string | undefined): boolean {
	return value?.startsWith(CONNECTOR_PREFIX) === true;
}

/**
 * Who is at the connector door: a process holding a credential mason issued, for an entry that is still enabled.
 *
 * Three checks, and each one is a different question. The **Origin** says the request is not a page's — a connector is a
 * process, and a browser that somehow holds a connector credential is not a shape mason accepts. The **credential** is
 * read from the `Authorization` header only: a connector has headers, so a credential in a URL would be a credential in
 * a log for no gain. The **entry** must still be enabled and still declare a connector, so revoking an entry's switch
 * closes its socket on the next connection without a restart.
 *
 * The refused answer says nothing about which half failed, and the caller logs the reason rather than sending it.
 */
export interface ConnectorIdentity {
	readonly name: string;
	readonly integration: Integration;
	readonly record: ConnectorCredential;
}

export async function authenticateConnector(
	request: IncomingMessage,
	home: string,
	integrations: Record<string, Integration>,
): Promise<
	{ readonly ok: true; readonly identity: ConnectorIdentity } | { readonly ok: false; readonly reason: string }
> {
	if (!originAllowed(request)) return { ok: false, reason: "origin" };
	const presented = bearer(request);
	if (!isConnectorCredentialShape(presented)) return { ok: false, reason: "credential" };
	const record = verifyConnectorCredential(await listConnectorCredentials(home), presented);
	if (record === undefined) return { ok: false, reason: "credential" };
	const integration = integrations[record.connector];
	if (integration === undefined || !integration.enabled || integration.connector === undefined) {
		return { ok: false, reason: "the connector entry is absent, switched off or declares no connector" };
	}
	return { ok: true, identity: { name: record.connector, integration, record } };
}

/** The bearer credential of a request, and nothing else: no query string, no cookie, no second way in. */
export function bearer(request: IncomingMessage): string | undefined {
	const header = request.headers.authorization;
	if (typeof header !== "string") return undefined;
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
	return match?.[1];
}
