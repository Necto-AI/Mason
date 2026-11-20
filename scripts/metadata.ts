/**
 * `npm run check:metadata` — the manifest a publisher reads, compared with the tree it is about.
 *
 * A manifest is read twice by two different people: by npm, which takes what it finds, and by a stranger on the package's
 * page, who decides whether to install it. Neither of those readers fails. A field that went missing is a page with no
 * repository link, a `files` entry that names nothing is a directory the tarball silently does not carry, and a declared
 * Node floor below a dependency's is an install that works on the machine it was published from. Every one of them is a
 * fact two files state and, until this check, nothing compared.
 *
 * The comparisons, each read from where it is written rather than from a policy file that would drift like NOTICE did:
 *
 * - the published runtime's publishable fields, because that is the npm page;
 * - every `files` entry, against the tree — npm includes an entry only when it exists, and the one a build writes is the
 *   one that goes missing; that entry is exempt here and proven where it belongs, by the checks that install the tarball;
 * - `prepack` on both published packages: without it a `npm publish` from a checkout packs the sources, and a consumer's
 *   Node refuses to strip types in `node_modules`;
 * - the declared Node floor, against the floor of every dependency it declares, read out of the lockfile's installed
 *   tree. Only a `>=` floor is compared; anything else is a refusal rather than a guess, because a range this check does
 *   not understand is a floor nobody is measuring;
 * - a host's home path in a file a stranger reads. `/home/<name>/` and `/Users/<name>/` are the maintainer's machine,
 *   published as if it were everybody's; `/home/mason/` is the container's account and is the one allowed.
 *
 * What it does not scan is as deliberate as what it does. Code, tests and build output are not files a stranger is handed,
 * and they carry example paths on purpose — a fixture with a home in it is a fixture about a home — while `docs/research/`
 * quotes other projects verbatim. The prose, the deploy files and the manifests are where a home path is a leak.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** The three manifests npm publishes from this repository. */
const MANIFESTS = [
	"packages/mason-agent/package.json",
	"packages/protocol/package.json",
	"packages/client/package.json",
] as const;

/** The two workspace packages: published on their own, so each needs its own build before npm touches it. */
const WORKSPACES = MANIFESTS;

/** The fields a stranger's first look is made of, on the published runtime: the package's npm page. */
const PUBLISHABLE = ["description", "keywords", "homepage", "repository", "license"] as const;

/** A declared floor this check can compare: `>=26.4`, `>=22.19.0`. Nothing looser, because an open range states none. */
const FLOOR = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/;

/** A home directory that belongs to a person rather than to the container's own account. */
const HOST_HOME = /\/(?:home|Users)\/([A-Za-z0-9_.-]+)\//g;

/** The one account a path in this repository may name: the container's, which is the same path on every host. */
const CONTAINER_HOME = "mason";

/** Directories whose files a stranger is not handed: code, tests, tooling, build output. */
const NOT_SHIPPED = new Set(["src", "test", "tests", "scripts", "evals", "node_modules", "dist"]);

/**
 * A `files` entry the package's own `prepack` writes, so it is not in a fresh clone by design. The checks that install
 * the tarball are what prove it arrived — `prove:package` boots the installed `dist/`, `prove:client` imports both
 * packages' — and requiring it here would only make this check need a build to run.
 */
const BUILT = new Set(["dist"]);

const read = (path: string): string => readFileSync(join(root, path), "utf8");

interface Manifest {
	/** Where it is, relative to the repository root: the name in every message. */
	readonly path: string;
	/** The directory its `files` entries and its dependencies resolve against. */
	readonly dir: string;
	readonly json: {
		readonly dependencies?: Readonly<Record<string, string>>;
		readonly engines?: Readonly<Record<string, string>>;
		readonly files?: readonly string[];
		readonly scripts?: Readonly<Record<string, string>>;
	} & Readonly<Record<string, unknown>>;
}

function manifests(): Manifest[] {
	return MANIFESTS.map((path) => ({
		path,
		dir: path.slice(0, path.lastIndexOf("/") + 1),
		json: JSON.parse(read(path)),
	}));
}

/** The installed tree's view of one package: the lockfile entry a dependency resolves to, following a workspace link. */
interface Installed {
	readonly where: string;
	readonly floor: string | undefined;
}

function installed(lock: Readonly<Record<string, InstalledEntry>>, name: string): Installed {
	const entry = lock[`node_modules/${name}`];
	if (entry === undefined) return { where: name, floor: undefined };
	// A workspace is a symlink in `node_modules` and a directory of its own in the lock; its engines are on the target.
	const target = entry.link === true && entry.resolved !== undefined ? lock[entry.resolved] : entry;
	if (entry.link === true && target === undefined) return { where: name, floor: undefined };
	return { where: entry.link === true ? String(entry.resolved) : name, floor: target?.engines?.node };
}

interface InstalledEntry {
	readonly engines?: Readonly<Record<string, string>>;
	readonly link?: boolean;
	readonly resolved?: string;
}

/** A parsed `>=x.y.z`, or `undefined` when the range is one this check refuses to interpret. */
function floor(range: string): readonly [number, number, number] | undefined {
	const match = FLOOR.exec(range.trim());
	if (match === null) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compare(left: readonly number[], right: readonly number[]): number {
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** Every tracked file whose content a stranger receives, as the repository records it. */
function shipped(): string[] {
	const listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
	return listed.filter((path) => path !== "" && ships(path));
}

function ships(path: string): boolean {
	if (path.startsWith("docs/research/")) return false;
	const segments = path.split("/").slice(0, -1);
	return !segments.some((segment) => NOT_SHIPPED.has(segment));
}

/** The manifest's publishable facts, in the order a stranger meets them on the package's page. */
function publishable(manifest: Manifest): string[] {
	const problems: string[] = [];
	for (const field of PUBLISHABLE) {
		const value = manifest.json[field];
		const empty =
			value === undefined ||
			value === null ||
			(typeof value === "string" && value.trim() === "") ||
			(Array.isArray(value) && value.length === 0);
		const repository = field === "repository" && typeof value === "object" && value !== null;
		const url = repository ? (value as { url?: unknown }).url : "";
		if (empty || (repository && (typeof url !== "string" || url.trim() === ""))) {
			problems.push(
				`${manifest.path}: ${repository ? "repository.url" : field} is missing, and npm's page shows it`,
			);
		}
	}
	return problems;
}

/** Every `files` entry, against the tree it promises. */
function files(manifest: Manifest): string[] {
	const problems: string[] = [];
	for (const entry of manifest.json.files ?? []) {
		if (BUILT.has(entry) || existsSync(join(root, manifest.dir, entry))) continue;
		problems.push(`${manifest.path}: files names ${entry}, which is not in the tree`);
	}
	return problems;
}

/** The declared floor, against the floor of everything the manifest depends on. */
function engines(manifest: Manifest, lock: Readonly<Record<string, InstalledEntry>>): string[] {
	const problems: string[] = [];
	const declared = manifest.json.engines?.node;
	if (declared === undefined) {
		problems.push(`${manifest.path}: engines.node is missing, so nothing states the Node this needs`);
		return problems;
	}
	const own = floor(declared);
	if (own === undefined) {
		problems.push(`${manifest.path}: engines.node ${declared} is not a >=x.y.z range, so it cannot be compared`);
		return problems;
	}
	for (const name of Object.keys(manifest.json.dependencies ?? {}).sort()) {
		const dependency = installed(lock, name);
		if (dependency.floor === undefined) continue;
		const theirs = floor(dependency.floor);
		if (theirs === undefined) {
			problems.push(
				`${manifest.path}: ${name} declares ${dependency.floor}, not a >=x.y.z range, so this check will not guess`,
			);
			continue;
		}
		if (compare(own, theirs) < 0) {
			const via = dependency.where === name ? "" : ` (${dependency.where})`;
			problems.push(`${manifest.path}: engines.node ${declared} is below ${name}'s ${dependency.floor}${via}`);
		}
	}
	return problems;
}

/** Every home path a stranger would read as their own. */
function homes(): string[] {
	const problems: string[] = [];
	for (const path of shipped()) {
		const text = read(path);
		if (!text.includes("/home/") && !text.includes("/Users/")) continue;
		for (const match of text.matchAll(HOST_HOME)) {
			if (match[1] === CONTAINER_HOME) continue;
			const line = text.slice(0, match.index).split("\n").length;
			problems.push(`${path}:${line}: ${match[0]} is one host's home, not the reader's`);
		}
	}
	return problems;
}

/** Every disagreement, in the order a reader meets them. Empty is the pass. */
export function problems(): string[] {
	const found: string[] = [];
	const lock = (JSON.parse(read("package-lock.json")) as { packages: Record<string, InstalledEntry> }).packages;
	for (const manifest of manifests()) {
		if (manifest.path === MANIFESTS[0]) found.push(...publishable(manifest));
		found.push(...files(manifest));
		if ((WORKSPACES as readonly string[]).includes(manifest.path) && manifest.json.scripts?.prepack === undefined) {
			found.push(`${manifest.path}: scripts.prepack is missing, so a publish from a checkout packs the sources`);
		}
		found.push(...engines(manifest, lock));
	}
	found.push(...homes());
	return found;
}

const found = problems();
if (found.length > 0) {
	for (const problem of found) console.error(`[metadata] ${problem}`);
	process.exit(1);
}
console.log(
	`[metadata] ${MANIFESTS.length} manifests, their dependencies' floors, and ${shipped().length} shipped files`,
);
