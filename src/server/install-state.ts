/**
 * Install state: which connectors `mason setup` put in this home, where each one came from, and whether it was started.
 *
 * `service/connectors.json` is written by the CLI and by nothing else. The server never reads it: what the server needs
 * from a connector is its grant, and that lives in `service/integrations.json` through the writer that already exists
 * (`integrations.ts`). The split is deliberate — an `integrations.json` that a CLI bug can malform refuses the boot and
 * takes the bot down, while a malformed install record costs one `mason setup` and nothing else. So this file is the
 * operator's note about what was done, and the server is not allowed to depend on it.
 *
 * The `source` grammar is fixed now and only partly implemented. `catalog:` and `url:` work in this release; `npm:` and
 * `git:` parse, validate, and refuse with "not available in this release". They are parsed anyway so that the day they
 * work, no file on disk has to change shape — a record written by 0.1.0 is a record 0.1.1 can start.
 */
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic.ts";
import type { HousePaths } from "./house.ts";

/** A name here is also an integration name and the connector name on its socket, so one grammar serves all three. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Where a connector came from, as `source` says it. */
export type InstallSource =
	/** One of mason's own, from the catalog shipped in this release. */
	| { readonly kind: "catalog"; readonly name: string; readonly version: string }
	/** A connector already deployed somewhere else: setup writes the grant and the credential and starts nothing. */
	| { readonly kind: "url"; readonly url: string }
	/** An npm package with a `mason` key. Parsed, refused in this release (0.1.1). */
	| { readonly kind: "npm"; readonly package: string; readonly version: string }
	/** A repository at a ref. Parsed, refused in this release (0.1.1). */
	| { readonly kind: "git"; readonly host: string; readonly repo: string; readonly ref: string };

/** One connector this home has installed. */
export interface ConnectorInstall {
	/** The text it was installed from, kept verbatim: `parseSource` reads it back, and a person reads it in a diff. */
	readonly source: string;
	/** The image and tag, for a source that names one. Absent for a `url:` connector: that one runs elsewhere. */
	readonly image?: string;
	readonly version?: string;
	/** The compose project setup generated for it — `<home-id>-<connector>` — so a restart names the stack it starts. */
	readonly project: string;
	readonly createdAt: string;
	/** Whether setup started it. `false` is a real state: `--no-start` wrote the files and left the container down. */
	readonly started: boolean;
}

/** `service/connectors.json`. */
export interface ConnectorInstalls {
	readonly connectors: Readonly<Record<string, ConnectorInstall>>;
}

function refusal(where: string, text: string, message: string): string {
	return `${where}: source "${text}" ${message}`;
}

const SCHEMES = "catalog:<name>@<version>, url:<ws-url>, npm:<package>@<version> or git:<host>/<repo>@<ref>";

/**
 * The text after the last `@`, and the text before it.
 *
 * `lastIndexOf` rather than `indexOf` because an npm scope starts with one: `npm:@scope/pkg@1.0.0` has three `@`, and
 * only the last separates the version.
 */
function splitAt(text: string, where: string, source: string): [string, string] {
	const at = text.lastIndexOf("@");
	if (at <= 0 || at === text.length - 1) throw new Error(refusal(where, source, `names no version: it is ${SCHEMES}`));
	return [text.slice(0, at), text.slice(at + 1)];
}

/**
 * What a `source` string means, or a refusal that lists the four forms.
 *
 * A `url:` source is the one that carries no version, because the connector it names is deployed somewhere else and this
 * home has no say over what runs there. Every other form carries one, since a connector mason starts has to be pinnable:
 * a first run that silently tracks `latest` is a bot that changes under its owner.
 */
export function parseSource(source: string, where = "connectors.json"): InstallSource {
	if (source.startsWith("catalog:")) {
		const [name, version] = splitAt(source.slice("catalog:".length), where, source);
		if (!NAME.test(name))
			throw new Error(refusal(where, source, "has a name that is not lowercase letters, digits and dashes"));
		return { kind: "catalog", name, version };
	}
	if (source.startsWith("url:")) {
		const url = source.slice("url:".length);
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(refusal(where, source, "is not a URL"));
		}
		// A connector opens its socket: `http://` is the same address as seen by a browser and by nothing else, and a
		// credential on a plaintext socket to another host is a credential in every proxy log between here and there.
		if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
			throw new Error(
				refusal(where, source, `is not a WebSocket URL: the scheme is ws: or wss:, not ${parsed.protocol}`),
			);
		return { kind: "url", url };
	}
	if (source.startsWith("npm:")) {
		const [name, version] = splitAt(source.slice("npm:".length), where, source);
		// A package name is npm's grammar, not mason's: a scope is `@scope/name`, and neither half is an integration name.
		if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
			throw new Error(refusal(where, source, "has a package name npm would not accept"));
		return { kind: "npm", package: name, version };
	}
	if (source.startsWith("git:")) {
		const [address, ref] = splitAt(source.slice("git:".length), where, source);
		const [host, ...path] = address.split("/");
		if (host === undefined || path.length === 0 || path.some((part) => part === ""))
			throw new Error(refusal(where, source, "is not <host>/<owner>/<repo>"));
		return { kind: "git", host, repo: path.join("/"), ref };
	}
	throw new Error(refusal(where, source, `is not a source mason reads: it is ${SCHEMES}`));
}

/**
 * Refuses a source this release cannot install, naming the form and when it arrives. Called by setup before it writes a
 * single file: a record for a connector that was never installed is worse than a refusal, because the next `setup`
 * would believe the work was done.
 */
export function requireInstallable(source: InstallSource): void {
	if (source.kind === "npm" || source.kind === "git")
		throw new Error(
			`"${source.kind}:" connectors are not available in this release: 0.1.0 installs mason's own catalog entries ` +
				"and connectors that are already running somewhere else (`--connector custom --url `). The form parses " +
				"today, so a record written now keeps working when the install path lands in 0.1.1.",
		);
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** The file's path, and the directory one connector's compose project is generated in. */
export function installPaths(paths: HousePaths): { readonly record: string; readonly directory: string } {
	return { record: paths.connectors, directory: paths.connectorsDir };
}

/**
 * Every install record, or an empty set when there is no file — the state a fresh home is in.
 *
 * A file that cannot be read or parsed is a refusal naming the path and what to do: it is written only by this module,
 * so a broken one is a bug or a hand edit, and either is one `mason setup` away from being rebuilt.
 */
export async function readInstalls(paths: HousePaths): Promise<ConnectorInstalls> {
	const { record } = installPaths(paths);
	const text = await readFile(record, "utf8").catch((error: unknown) => {
		if (isMissingFile(error)) return undefined;
		throw new Error(`cannot read ${record}: ${error instanceof Error ? error.message : String(error)}`);
	});
	if (text === undefined) return { connectors: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${record} is not JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`${record} is not a JSON object: it holds one key, "connectors", mapping names to records.`);
	const declared = (parsed as Record<string, unknown>).connectors;
	if (declared === undefined) throw new Error(`${record} has no "connectors" key: nothing would be read from it.`);
	if (typeof declared !== "object" || declared === null || Array.isArray(declared))
		throw new Error(`${record}: "connectors" is not an object mapping names to records.`);
	const connectors: Record<string, ConnectorInstall> = {};
	for (const [name, value] of Object.entries(declared)) {
		if (!NAME.test(name)) throw new Error(`${record}: "${name}" is not a connector name`);
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error(`${record}: connector "${name}" is not a JSON object`);
		const raw = value as Record<string, unknown>;
		if (typeof raw.source !== "string") throw new Error(`${record}: connector "${name}" has no "source"`);
		// The source is re-parsed on read, not trusted: a record this release cannot install is a record the next
		// command should not act on, and saying so here is one place instead of every caller.
		parseSource(raw.source, record);
		if (typeof raw.project !== "string" || raw.project === "")
			throw new Error(`${record}: connector "${name}" has no "project": it is the stack setup generated`);
		if (typeof raw.createdAt !== "string" || raw.createdAt === "")
			throw new Error(`${record}: connector "${name}" has no "createdAt"`);
		if (typeof raw.started !== "boolean")
			throw new Error(`${record}: connector "${name}" has a "started" that is not true or false`);
		connectors[name] = {
			source: raw.source,
			...(typeof raw.image === "string" ? { image: raw.image } : {}),
			...(typeof raw.version === "string" ? { version: raw.version } : {}),
			project: raw.project,
			createdAt: raw.createdAt,
			started: raw.started,
		};
	}
	return { connectors };
}

/**
 * One connector's record, written and keeping every other one.
 *
 * `writeFileAtomic` because the file holds no secret and still must not be seen half-written; names are sorted so the
 * file reads the same in a diff on both sides of an install.
 */
export async function writeInstall(
	paths: HousePaths,
	name: string,
	install: ConnectorInstall,
): Promise<ConnectorInstall> {
	if (!NAME.test(name)) throw new Error(`"${name}" is not a connector name`);
	parseSource(install.source);
	const { record } = installPaths(paths);
	const { connectors } = await readInstalls(paths);
	const names = [...new Set([...Object.keys(connectors), name])].sort((left, right) => (left < right ? -1 : 1));
	await writeFileAtomic(record, {
		connectors: Object.fromEntries(names.map((key) => [key, key === name ? install : connectors[key]])),
	});
	return install;
}

/** Forgets one connector. `false` when there was none, so a typo does not read as a successful removal. */
export async function removeInstall(paths: HousePaths, name: string): Promise<boolean> {
	const { connectors } = await readInstalls(paths);
	if (connectors[name] === undefined) return false;
	const remaining = Object.fromEntries(Object.entries(connectors).filter(([key]) => key !== name));
	await writeFileAtomic(installPaths(paths).record, { connectors: remaining });
	return true;
}
