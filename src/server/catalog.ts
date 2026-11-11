/**
 * The connector catalog: what mason knows how to install, shipped in the package and read from disk.
 *
 * `mason setup` cannot ask a stranger to find a connector image, so the list has to travel with the release —
 * `catalog/connectors.json` is that list, and this file is its only reader. An entry says what mason needs in order to
 * wire one up and nothing about how the connector works inside: the image to run, the env a person is asked for, the
 * face it may claim, its controls and the port it listens on. The protocol, the SDK and the behaviour stay in the
 * connector's own repository, where they can change without a release here.
 *
 * The parse is closed. A key this file does not know is a refusal and not a shrug, because the two failure modes are
 * not symmetric: a typo in `optional` would be read as "required" and a typo in `secret` would echo a bot token into a
 * terminal in full view. Refusing the entry names the key and costs the operator one line; ignoring it costs them the
 * thing the key was for. The shipped file is pinned by a test for the same reason — a catalog that cannot parse is a
 * `mason setup` that offers nothing. It ships empty in 0.1.0, and the emptiness is deliberate: the console connector is
 * built in and is not a catalog entry, while the one entry this file held named an image no workflow publishes, so a
 * stranger's first run ended at a container that could never start (#151). The parser and its refusals stay; only the
 * entry went, and the catalog gains it back when its image travels with a release.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CAPABILITIES, type Capability, CONTROL_OPS, type ControlOp } from "mason-protocol";

/**
 * Where the list lives, from this module either way: three directories up from `src/server/` is the checkout's root,
 * and three up from `dist/src/server/` is `dist/`, where the build copies it (`scripts/build-runtime.ts`). One constant
 * for both is the same trick `skills/` uses, and it is why the catalog needs no path in a config file.
 */
export const CATALOG_PATH = join(import.meta.dirname, "../../catalog/connectors.json");

/** A name in this file is also the integration name in a home and the connector name on the socket, so: one grammar. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * One thing a person types at `mason setup`. The value becomes a compose environment variable and goes no further.
 *
 * One name is load-bearing beyond the container: an env whose name ends in `_CHATS` is the list of conversations the
 * grant allows, comma separated. A user face needs a room to carry words in, the connector's own grant names them, and
 * this is where setup learns them without asking a second question (#145: the wizard asks who owns the chat, and the
 * rooms follow from the answer the connector already needs).
 */
export interface CatalogEnv {
	readonly name: string;
	/** Asked without echoing, and kept out of the install record: the value is a bot token, not a preference. */
	readonly secret?: boolean;
	/** Left out of the compose file when unanswered. Absent means setup will not start without it. */
	readonly optional?: boolean;
	/** What to tell the person, in the one line the wizard shows beside the prompt. */
	readonly prompt: string;
}

/** The face the connector claims, and the ceiling the grant is written at: the grant never widens what an entry says. */
export interface CatalogConnector {
	readonly capabilities: readonly Capability[];
	readonly commands: readonly ControlOp[];
}

/**
 * Where the connector answers on its own network: the port its MCP endpoint listens on.
 *
 * Nothing reads it in this release, on purpose. A connector's MCP server is reachable at this port inside the podman
 * network, mason lives on the host, and setup publishes no host port — so the entry it writes carries the grant and no
 * `tools` block (`scripts/setup.ts` says the same at the top). The field is parsed and validated now so the release that
 * puts mason in that network has the number it needs and no file has to change shape.
 */
export interface CatalogContainer {
	readonly port: number;
}

/** One installable connector. */
export interface CatalogEntry {
	readonly name: string;
	readonly description: string;
	/** The repository, without a tag: the tag comes from `version`, so a bump is one field and not two. */
	readonly image: string;
	readonly version: string;
	readonly connector: CatalogConnector;
	readonly env: readonly CatalogEnv[];
	readonly container: CatalogContainer;
}

/** `catalog/connectors.json`. */
export interface Catalog {
	readonly connectors: readonly CatalogEntry[];
}

function refusal(where: string, path: string, message: string): string {
	return `${where}: connector "${path}" ${message}`;
}

/**
 * A JSON object whose every key has been named by its reader. `allowed` is the closed set for this shape; a key outside
 * it is the refusal described above, and the message lists what was expected so the fix does not need the source.
 */
function record(where: string, path: string, value: unknown, allowed: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(refusal(where, path, "is not a JSON object"));
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (!allowed.includes(key))
			throw new Error(
				refusal(
					where,
					path,
					`has an unknown key "${key}": this file is read by mason, so it accepts ${allowed.join(", ")} and ` +
						"nothing else",
				),
			);
	}
	return raw;
}

function text(where: string, path: string, key: string, value: unknown): string {
	if (typeof value !== "string" || value.trim() === "")
		throw new Error(refusal(where, path, `has no "${key}": it is a non-empty string`));
	return value.trim();
}

function flag(where: string, path: string, key: string, value: unknown): boolean {
	if (value === undefined) return false;
	if (typeof value !== "boolean") throw new Error(refusal(where, path, `has a "${key}" that is not true or false`));
	return value;
}

function oneOf<T extends string>(where: string, path: string, key: string, value: unknown, allowed: readonly T[]): T {
	if (typeof value !== "string" || !allowed.includes(value as T))
		throw new Error(
			refusal(
				where,
				path,
				`has a "${key}" of ${JSON.stringify(value)}: the protocol's vocabulary is ${allowed.join(", ")}, and the ` +
					"grant written from this entry cannot widen it",
			),
		);
	return value as T;
}

function envOf(where: string, path: string, value: unknown): readonly CatalogEnv[] {
	if (!Array.isArray(value)) throw new Error(refusal(where, path, `has no "env" list`));
	return value.map((item, index) => {
		const at = `${path}.env[${index}]`;
		const raw = record(where, at, item, ["name", "secret", "optional", "prompt"]);
		const name = text(where, at, "name", raw.name);
		// The environment of a container is `NAME=value` lines: a name with a space or an `=` in it would either be
		// dropped by compose or silently become a different variable than the one the connector reads.
		if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
			throw new Error(refusal(where, at, `has a name "${name}": environment names are A-Z, digits and underscores`));
		return {
			name,
			prompt: text(where, at, "prompt", raw.prompt),
			...(flag(where, at, "secret", raw.secret) ? { secret: true } : {}),
			...(flag(where, at, "optional", raw.optional) ? { optional: true } : {}),
		};
	});
}

function connectorOf(where: string, path: string, value: unknown): CatalogConnector {
	const raw = record(where, path, value, ["capabilities", "commands"]);
	if (!Array.isArray(raw.capabilities))
		throw new Error(refusal(where, path, `has no "capabilities" list: it is what the connector may claim`));
	if (!Array.isArray(raw.commands))
		throw new Error(refusal(where, path, `has no "commands" list: it is the ceiling of its controls`));
	return {
		capabilities: raw.capabilities.map((item) => oneOf(where, path, "capability", item, CAPABILITIES)),
		commands: raw.commands.map((item) => oneOf(where, path, "command", item, CONTROL_OPS)),
	};
}

function containerOf(where: string, path: string, value: unknown): CatalogContainer {
	const raw = record(where, path, value, ["port"]);
	// A port is `1..65535` and is written into the compose file as the port the connector answers on. Zero would be a
	// container listening nowhere, and anything higher is not a TCP port at all.
	if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65_535)
		throw new Error(refusal(where, path, `has no usable "port": an integer from 1 to 65535`));
	return { port: raw.port };
}

function entryOf(where: string, value: unknown): CatalogEntry {
	const raw = record(where, "(entry)", value, [
		"name",
		"description",
		"image",
		"version",
		"connector",
		"env",
		"container",
	]);
	const name = text(where, "(entry)", "name", raw.name);
	if (!NAME.test(name))
		throw new Error(
			refusal(
				where,
				name,
				"is not a usable name: lowercase letters, digits and dashes, starting with a letter or a digit — it is " +
					"the integration name and the connector name on the socket",
			),
		);
	return {
		name,
		description: text(where, name, "description", raw.description),
		image: text(where, name, "image", raw.image),
		version: text(where, name, "version", raw.version),
		connector: connectorOf(where, name, raw.connector),
		env: envOf(where, name, raw.env),
		container: containerOf(where, name, raw.container),
	};
}

/**
 * The file, checked. Exported for the test that holds the shipped file to this parse without reading the filesystem —
 * and because a second reader of the same file must not grow a second opinion about what is valid.
 */
export function parseCatalog(value: unknown, where = "connectors.json"): Catalog {
	const file = record(where, "(file)", value, ["connectors"]);
	if (!Array.isArray(file.connectors))
		throw new Error(`${where}: "connectors" is not a list: it is one entry per connector mason knows how to install`);
	const connectors = file.connectors.map((item) => entryOf(where, item));
	const seen = new Set<string>();
	for (const entry of connectors) {
		if (seen.has(entry.name)) throw new Error(`${where}: two connectors are named "${entry.name}"`);
		seen.add(entry.name);
	}
	return { connectors };
}

/** The catalog this install ships. A file that cannot be read is a refusal naming the path, never an empty list: an
 * install that silently offers no connector is the failure a stranger cannot diagnose. An empty list is only the parsed
 * file's own word for it, which is why 0.1.0's empty catalog is pinned by a test and named in the refusal below. */
export async function readCatalog(path = CATALOG_PATH): Promise<Catalog> {
	const text = await readFile(path, "utf8").catch((error: unknown) => {
		throw new Error(
			`cannot read the connector catalog at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	return parseCatalog(parsed, path);
}

/** One entry by name, or a refusal that lists what there is: `--connector teleram` should not need the docs. */
export async function catalogEntry(name: string, path = CATALOG_PATH): Promise<CatalogEntry> {
	const { connectors } = await readCatalog(path);
	const found = connectors.find((entry) => entry.name === name);
	if (found === undefined) {
		const known =
			connectors.length === 0
				? "this release ships no catalog connectors: the terminal is built in (`--connector console`), and a connector " +
					"already running somewhere else is `--connector custom --url <ws-url>`"
				: `it knows ${connectors.map((entry) => entry.name).join(", ")}`;
		throw new Error(`there is no connector "${name}" in the catalog: ${known}`);
	}
	return found;
}
