/**
 * Connectors: the grants a service holds, and the credential it opens its socket with.
 *
 * A connector is one external process with up to two faces — it carries people's words and reports events — and it is
 * the same entry in `service/integrations.json` that owns the MCP server mason calls. The socket grants words and events;
 * tools are not a face. They are the entry's `mcp`, reached by mason in the other direction, and the reason a connector
 * that advertises one is told its url rather than told it may use it. The `connector` block is what the operator grants
 * it: which external actor is the owner's, which external conversations may be spoken in, which event kinds fire which
 * routine, and which controls it may spend on `mason/control`.
 *
 * Everything here is a **ceiling**, never a wish. The connector advertises its faces at the handshake and the answer is
 * the intersection with this file: an actor that is not the owner is refused, a conversation that is not listed is refused,
 * a kind that maps to no routine is refused. A face the entry does not grant is
 * named in `inactive` with a reason rather than dropped, because a connector silently missing half its behaviour is the
 * bug nobody finds.
 *
 * The file is validated where every integration is validated (`integrations.ts`), so a grant that cannot work refuses
 * the boot instead of leaving a connector with fewer powers than its operator believes it has.
 *
 * ## The credential
 *
 * Mason issues one credential per connector. It is stored as a SHA-256 hash in `service/config.json` — that file ends up
 * in bug reports — and read on every upgrade request, so a revoke lands on the next connection rather than on the next
 * restart. It opens `/api/connector` and the attachment upload, and nothing else. The credential for mason's own MCP
 * calls is the other direction: it is configured on the entry's MCP server (`mcp.credential`) and never leaves the server
 * except on that call.
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
} from "mason-protocol";
import { originAllowed, readConfig, updateConfig } from "./auth.ts";
import type { Integration } from "./integrations.ts";

/** A leaked connector credential is recognisable in a log, and distinct from an owner token at a glance. */
export const CONNECTOR_PREFIX = "masonc_";

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
	/**
	 * The controls this connector's socket may spend on `mason/control`, out of the protocol's closed vocabulary. Absent
	 * or empty is no vocabulary at all: a chat that was never granted `stop` is a chat that cannot interrupt a turn, and
	 * saying so at the handshake's first refusal is better than a word that silently never runs.
	 */
	readonly commands?: readonly ControlOp[];
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
	return `${where}: integration "${name}" ${message}; fix the entry by hand, then run \`mason doctor\``;
}

/**
 * One entry's `connector` block, checked and normalised, or `undefined` when the entry declares no connector.
 *
 * A block with no face at all is refused: it would issue a credential that opens a socket with nothing on it, which is
 * the shape of a half-finished configuration nobody notices until the connector asks why it is silent. An entry's MCP
 * server is not a face and does not count here: a connector that only wants to learn its own url is not a connector.
 */
export function readConnectorGrant(where: string, name: string, value: unknown): ConnectorGrant | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has a "connector" that is not an object'));
	}
	const raw = value as Record<string, unknown>;
	// The keys the approval apparatus owned. They were required once, so every file written before the cut carries one,
	// and reading past them would leave an operator believing a rule still runs.
	const retired = RETIRED_GRANT_KEYS.filter((key) => raw[key] !== undefined);
	if (retired.length > 0) {
		throw new Error(
			refusal(
				where,
				name,
				`has a retired "connector.${retired[0]}": there is no approval step and no state mirror any more, so the ` +
					"grant is its faces and its commands. Delete that key by hand",
			),
		);
	}
	const user = readUser(where, name, raw.user);
	const events = readEvents(where, name, raw.events);
	const commands = readCommands(where, name, raw.commands);
	const hasFace = user !== undefined || events !== undefined;
	if (!hasFace) {
		throw new Error(
			refusal(
				where,
				name,
				'has a "connector" that grants no face: a user face, an events face or both is what a connector is, and the ' +
					'entry\'s "mcp" server is not one of them',
			),
		);
	}
	return {
		...(user === undefined ? {} : { user }),
		...(events === undefined ? {} : { events }),
		...(commands === undefined ? {} : { commands }),
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
 * The grant keys a removed mechanism owned — approval markers that waived the gateway, the policy rules it read, and the
 * state scopes a connector mirrored. Two of them were required, so every file written before the cut carries one.
 *
 * Refused rather than ignored: a file that still says a rule runs is a file whose operator believes it runs.
 */
export const RETIRED_GRANT_KEYS = ["state", "trustMarkers", "policy"] as const;

/**
 * The keys a user face carried when mason kept a room: a mapping, an escape hatch for strangers, and a named approver.
 *
 * Refused for the same reason: a file that still says who may speak is a file whose reader believes it decides that.
 */
export const RETIRED_USER_KEYS = ["actors", "unattributed", "approver"] as const;

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
					'"owner" actor and no mapping, no unattributed switch and no approver. Delete that key by hand',
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
		return {
			externalConversationId: id,
			kind,
			...(title === undefined ? {} : { title }),
		};
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

/** The enabled entry's grant, or `undefined` when the entry is absent, switched off or declares no connector. */
export function connectorGrantFor(
	integrations: Record<string, Integration>,
	name: string,
): { readonly integration: Integration; readonly grant: ConnectorGrant } | undefined {
	const integration = integrations[name];
	if (integration === undefined || !integration.enabled || integration.connector === undefined) return undefined;
	return { integration, grant: integration.connector };
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
	const credential = `${CONNECTOR_PREFIX}${randomBytes(32).toString("base64url")}`;
	const record: ConnectorCredential = {
		id: `con_${randomBytes(4).toString("hex")}`,
		connector,
		sha256: digest(credential),
		createdAt: new Date().toISOString(),
	};
	await updateConfig(home, (config) => {
		const existing = Array.isArray(config.connectors) ? config.connectors.filter(isCredentialRecord) : [];
		const kept = options.replace === true ? existing.filter((entry) => entry.connector !== connector) : existing;
		return { ...config, connectors: [...kept, record] };
	});
	return { credential, record };
}

/** Remove one credential. `false` when no such id: a typo must not read as a successful revoke. */
export async function revokeConnectorCredential(home: string, id: string): Promise<boolean> {
	let removed = false;
	await updateConfig(home, (config) => {
		const existing = Array.isArray(config.connectors) ? config.connectors.filter(isCredentialRecord) : [];
		const remaining = existing.filter((record) => record.id !== id);
		if (remaining.length === existing.length) return undefined;
		removed = true;
		return { ...config, connectors: remaining };
	});
	return removed;
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
		return {
			ok: false,
			reason: "the connector entry is absent, switched off or declares no connector",
		};
	}
	return {
		ok: true,
		identity: { name: record.connector, integration, record },
	};
}

/** The bearer credential of a request, and nothing else: no query string, no cookie, no second way in. */
export function bearer(request: IncomingMessage): string | undefined {
	const header = request.headers.authorization;
	if (typeof header !== "string") return undefined;
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
	return match?.[1];
}
