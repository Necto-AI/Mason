/**
 * `mason setup`'s decision, as a value: `planConnector` reads, and writes nothing.
 *
 * The command used to decide and act in one pass, which made three things impossible: a person could not see what it
 * would write before it wrote (the first preview was the result), the install could not be tested without podman, and
 * another program could not make the same artifacts. So the decision is here — the grant, the credential, the project
 * text, the entry the home does or does not already have — and the effect is `apply.ts`.
 *
 * What a plan may do is read: the catalog entry, `integrations.json`, the credentials in `config.json`, the install
 * records, the compose file a previous run rendered. Every refusal those reads can raise is raised here, which is the
 * order setup already had (a broken `config.json` used to be discovered after the grant had landed). What it may not do
 * is write, start, print, lock or reach the network.
 *
 * The one thing a plan cannot read is the credential it must issue, so it mints one: `mint` is a parameter, the default
 * makes a random credential, and a test injects a fixed one. Because the value travels inside the plan rather than being
 * made during the write, "two plans from the same answers are equal" is provable while the credential is still the one
 * the container will be handed.
 *
 * One dependency rule, which is the whole reason this sits under `src/`: `src/setup/` may import `src/server/`, never the
 * reverse. The runtime must not be able to reach a planner, and a command that hands a planner its answers is a view.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Capability, CONTROL_OPS, type ControlOp } from "mason-protocol";
import { catalogEntry } from "../server/catalog.ts";
import { composePath, projectName, readComposeCredential, renderCompose } from "../server/connector-compose.ts";
import {
	CONNECTOR_PREFIX,
	type ConnectorCredential,
	type ConnectorGrant,
	listConnectorCredentials,
} from "../server/connectors.ts";
import { parseRoutines } from "../server/hooks.ts";
import type { HousePaths } from "../server/house.ts";
import { type ConnectorInstall, parseSource, readInstalls, requireInstallable } from "../server/install-state.ts";
import { type Integration, readIntegrations } from "../server/integrations.ts";
import { RETRY_HOOK_ID } from "../server/run-retry.ts";

/** The answers a catalog entry asked for, by variable name: only the variables that were given a value. */
export type EnvAnswers = Readonly<Record<string, string>>;

/**
 * One connector's answers, before anything is written.
 *
 * Three shapes, because there are three ways a connector gets here: a catalog entry, whose questions are its `env`; an
 * address a connector is already running at; and the one connector whose grant is fixed in code. The last one takes its
 * facts from the caller on purpose — `console`'s grant and description live beside the process that serves them
 * (`scripts/chat.ts`), and a planner that imported a command would be the wrong way round.
 */
export type ConnectorAnswers =
	| {
			readonly kind: "catalog";
			/** The catalog entry's name, which is also the integration's. */
			readonly name: string;
			readonly env: EnvAnswers;
			/** The actor whose words are the person's: the one question the grant cannot answer for itself. */
			readonly owner: string;
	  }
	| {
			readonly kind: "url";
			/** The integration's name. `custom` today: a connector mason does not run. */
			readonly name: string;
			readonly url: string;
			readonly owner: string;
			/** Each kind it may fire and the routine it wakes. */
			readonly events: Readonly<Record<string, string>>;
	  }
	| {
			readonly kind: "fixed";
			readonly name: string;
			readonly description: string;
			readonly grant: ConnectorGrant;
			/** The address the connector dials, as the install record keeps it. */
			readonly source: string;
	  };

/** A credential a plan issues: the value, and the record whose hash is what the home keeps. */
export interface PlannedCredential {
	readonly record: ConnectorCredential;
	/** The credential itself. It exists in the plan, in the reply, and in the project the container is started from. */
	readonly plaintext: string;
	/** `true` when it replaces the one the home held: the project's plaintext was no longer behind the record's hash. */
	readonly replace: boolean;
}

/** What minting produces, before the plan says whether it is a first issue or a rotation. */
export type MintedCredential = Omit<PlannedCredential, "replace">;

/** Makes the credential a plan carries. A test injects one that returns the same value twice, and then two plans match. */
export type MintCredential = (connector: string) => MintedCredential;

/** One file a plan writes. */
export interface PlannedWrite {
	readonly path: string;
	readonly text: string;
	/** Write only when the path holds nothing: a file that is already there is the operator's, and the plan leaves it. */
	readonly onlyIfMissing?: boolean;
}

/** The compose project a plan writes and, unless `--no-start`, starts. */
export interface PlannedProject {
	readonly composeFile: string;
	readonly name: string;
}

/**
 * One connector's install, as a value: what it writes, what it mints, and what it starts.
 *
 * Applying this plan is one call (`applyPlan`), and the plan it applies is the plan that was printed: nothing between the
 * two decides anything again. That is why the reads travel in it — the entry that is already there, the credential that is
 * already held, the record a second run keeps — instead of being repeated at write time.
 */
export interface Plan {
	/** The home every write it implies lands in. */
	readonly paths: HousePaths;
	readonly name: string;
	readonly description: string;
	readonly grant: ConnectorGrant;
	/** The text the install record keeps: `catalog:<name>@<version>` or `url:<ws-url>`. */
	readonly source: string;
	readonly image?: string;
	readonly version?: string;
	/** The entry to write, or `undefined` when the home already grants this connector: a grant is added to, never rewritten. */
	readonly entry?: Integration;
	/** The credential the home already holds for this name, which a second run reports instead of minting one. */
	readonly held?: ConnectorCredential;
	/** The install record on disk before this run. Its `createdAt` and its `started` survive the next one. */
	readonly previous?: ConnectorInstall;
	/** The credential this run issues, or `undefined` when the home already holds the one the project is rendered with. */
	readonly credential?: PlannedCredential;
	/** The files this plan writes: the compose project, when the connector runs in a container. */
	readonly writes: readonly PlannedWrite[];
	/** The project those writes belong to, and the one applying the plan asks the runner to start. */
	readonly project?: PlannedProject;
}

/** Mason's port: the one `mason up` binds, so a container is told where the socket it dials answers. */
export function masonPort(): number {
	return Number(process.env.PORT ?? 8787);
}

/** The hash `mintConnectorCredential` stores: the one thing that says a plaintext is the credential this home holds. */
function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The real mint: the credential `connectors.ts` issues, made without the write that issues it.
 *
 * `mintConnectorCredential` mints and stores in one call, and a plan cannot have that: the value has to exist before
 * anything is written, because it is what the container is handed and what `--dry-run` promises. So the prefix, the id
 * and the digest are repeated here, and they are the shape that file mints. The store side of it is `applyPlan`'s:
 * `updateConfig` under the store's lock, one record appended, or one replaced.
 */
const randomMint: MintCredential = (connector) => {
	const plaintext = `${CONNECTOR_PREFIX}${randomBytes(32).toString("base64url")}`;
	return {
		plaintext,
		record: {
			id: `con_${randomBytes(4).toString("hex")}`,
			connector,
			sha256: sha256(plaintext),
			createdAt: new Date().toISOString(),
		},
	};
};

/**
 * What the grant says for a catalog connector: the owner, and the ceiling the catalog declares.
 *
 * The answer setup asks for, the person's own id, is the grant's one actor. Where a message goes is not a grant: a
 * connector is answered where its words came from.
 */
function catalogGrant(
	entry: { readonly capabilities: readonly Capability[]; readonly commands: readonly ControlOp[] },
	owner: string,
): ConnectorGrant {
	return {
		user: { owner, capabilities: [...entry.capabilities] },
		commands: [...entry.commands],
	};
}

/** The hooks a boot defines: the supervisor's retry, and every routine `agent/routines.json` carries. */
async function assertKnownHooks(paths: HousePaths, events: Readonly<Record<string, string>>): Promise<void> {
	const known = new Set<string>([RETRY_HOOK_ID]);
	const text = await readFile(join(paths.agentDir, "routines.json"), "utf8").catch(() => undefined);
	if (text !== undefined) {
		try {
			for (const routine of parseRoutines(text)) known.add(routine.name);
		} catch {
			// A malformed routines file is the boot's own refusal, with its own message; this check is about the grant.
		}
	}
	const unknown = Object.entries(events).filter(([, hook]) => !known.has(hook));
	if (unknown.length === 0) return;
	throw new Error(
		`${unknown.map(([kind, hook]) => `the kind "${kind}" fires "${hook}"`).join(", ")}, which is not a hook: ` +
			`this build defines ${[...known].map((name) => `"${name}"`).join(", ")}. Nothing was written.`,
	);
}

/** What a plan says about a connector before it reads a single thing about this home. */
interface Described {
	readonly name: string;
	readonly description: string;
	readonly grant: ConnectorGrant;
	readonly source: string;
	readonly image?: string;
	readonly version?: string;
	/** Whether setup runs a container for it. The console and a `custom` connector run somewhere else. */
	readonly container: boolean;
	/** The answers the container is handed, in the order they are written into its compose file. */
	readonly env: EnvAnswers;
}

/**
 * The grant, the source and the image, from the answers — the half of a plan that needs no home.
 *
 * Two refusals live here because this is what knows what they are about: a url that is not a socket would become a grant
 * and a credential for a connector that can never open one, and a grant that fires a hook no build defines is a home
 * that refuses to boot.
 */
async function describe(answers: ConnectorAnswers, paths: HousePaths, catalog?: string): Promise<Described> {
	if (answers.kind === "fixed")
		return {
			name: answers.name,
			description: answers.description,
			grant: answers.grant,
			source: answers.source,
			container: false,
			env: {},
		};
	if (answers.kind === "url") {
		requireInstallable(parseSource(`url:${answers.url}`));
		await assertKnownHooks(paths, answers.events);
		const { owner, url } = answers;
		return {
			name: answers.name,
			description: `A connector already running at ${url}`,
			grant: {
				user: { owner },
				...(Object.keys(answers.events).length === 0 ? {} : { events: { hooks: answers.events } }),
				commands: [...CONTROL_OPS],
			},
			source: `url:${url}`,
			container: false,
			env: {},
		};
	}
	const entry = await catalogEntry(answers.name, catalog);
	return {
		name: entry.name,
		description: entry.description,
		grant: catalogGrant(entry.connector, answers.owner),
		source: `catalog:${entry.name}@${entry.version}`,
		image: `${entry.image}:${entry.version}`,
		version: entry.version,
		container: true,
		env: answers.env,
	};
}

/**
 * One connector's install, decided and not done.
 *
 * The reads are in the order the failures matter: the answers first (nothing about the home can refuse them), then the
 * integrations file, the credentials and the install records — each of which a person may have broken by hand, and each
 * of which refuses by name. `readComposeCredential` is the last read, because it decides only whether this run rotates
 * the credential the project carries or reuses the one it found.
 */
export async function planConnector(
	answers: ConnectorAnswers,
	paths: HousePaths,
	// `catalog`: the shipped file unless a test names a fixture, so the entry-fed half stays pinned while 0.1.0 ships none.
	options: { readonly mint?: MintCredential; readonly catalog?: string } = {},
): Promise<Plan> {
	const mint = options.mint ?? randomMint;
	const described = await describe(answers, paths, options.catalog);
	const { integrations } = await readIntegrations(paths);
	const issued = await listConnectorCredentials(paths.home);
	const { connectors } = await readInstalls(paths);
	const existing = integrations[described.name];
	const held = issued.find((record) => record.connector === described.name);
	const previous = connectors[described.name];
	// A grant that is already there is added to, never rewritten: the entry is a permission, and the operator's own line
	// in it is not setup's to replace.
	const entry: Integration | undefined =
		existing?.connector === undefined
			? {
					...existing,
					enabled: true,
					description: existing?.description ?? described.description,
					connector: described.grant,
				}
			: undefined;
	const project = described.container
		? { composeFile: composePath(paths, described.name), name: projectName(paths.home, described.name) }
		: undefined;
	// A container needs the plaintext credential, and mason keeps only a hash. Two of them are usable, and both are
	// proven rather than assumed: a credential minted by this plan, or the file's own line when its hash is the hash this
	// home holds (the file is `0600`, and applying the plan rewrites it). Anything else is a rotation — revoked, deleted,
	// or rotated elsewhere by `mason connector add --replace` — and the credential nobody holds any more is dropped in
	// the same write, because a container left crash-looping on it is the failure this avoids.
	let credential: PlannedCredential | undefined;
	let plaintext: string | undefined;
	if (held === undefined) {
		credential = { ...mint(described.name), replace: false };
		plaintext = credential.plaintext;
	} else if (project !== undefined) {
		const inFile = await readComposeCredential(project.composeFile);
		if (inFile !== undefined && sha256(inFile) === held.sha256) plaintext = inFile;
		else {
			credential = { ...mint(described.name), replace: true };
			plaintext = credential.plaintext;
		}
	}
	const writes: PlannedWrite[] =
		project === undefined
			? []
			: [
					{
						path: project.composeFile,
						text: renderCompose({
							connector: described.name,
							image: described.image ?? "",
							home: paths.home,
							env: {
								MASON_CONNECTOR_URL: `ws://host.containers.internal:${masonPort()}/api/connector`,
								MASON_CONNECTOR_CREDENTIAL: plaintext ?? "",
								...described.env,
							},
						}),
					},
				];
	return {
		paths,
		name: described.name,
		description: described.description,
		grant: described.grant,
		source: described.source,
		...(described.image === undefined ? {} : { image: described.image }),
		...(described.version === undefined ? {} : { version: described.version }),
		...(entry === undefined ? {} : { entry }),
		...(held === undefined ? {} : { held }),
		...(previous === undefined ? {} : { previous }),
		...(credential === undefined ? {} : { credential }),
		writes,
		...(project === undefined ? {} : { project }),
	};
}
