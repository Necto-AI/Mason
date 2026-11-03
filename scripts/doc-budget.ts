/**
 * `npm run check:docs` — the word ceiling of every document that carries a fact, measured against the file it names.
 *
 * The documents in this repository are read by an agent in every session, so their length is a cost paid on every turn,
 * and the pressure on a document is always to grow: a new rule arrives, nobody removes the rule it replaced, and the
 * file drifts into a history of itself. A ceiling is the smallest thing that notices. `docs/doc-budgets.json` holds one
 * number per file, the number is today's size rounded up, and it only ever goes down — raising one is a decision the
 * pull request has to argue for (`docs/AGENTS.md`).
 *
 * Two failures, and both name the file: a document over its ceiling, and a manifest entry whose file is gone. The
 * second matters as much as the first — a renamed document that keeps its old ceiling is a document that stopped being
 * measured while the table still says it is.
 *
 * The count is whitespace-split tokens with code fences included: a table row, a shell command and a paragraph all cost
 * what they cost, and a rule with a fence around it is not free.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Where the ceilings live, relative to the repository root. */
export const MANIFEST_PATH = "docs/doc-budgets.json";

export interface Manifest {
	/** A path relative to the repository root, and the most words it may hold. */
	readonly ceilings: Readonly<Record<string, number>>;
	/** Documents a script writes. They are as long as the code they describe, so they carry no ceiling. */
	readonly generated: readonly string[];
}

export interface Row {
	readonly file: string;
	readonly words: number;
	readonly ceiling: number;
	/** Words still allowed. Negative when the file is over, which is the failure. */
	readonly headroom: number;
}

export interface Audit {
	/** One row per manifest entry whose file was read, in manifest order. */
	readonly rows: readonly Row[];
	/** Entries over their ceiling, as the sentence to print. */
	readonly over: readonly string[];
	/** Entries whose file is gone, as the sentence to print. */
	readonly missing: readonly string[];
	/** Documents in the tiers the manifest covers that carry no ceiling, as the sentence to print. */
	readonly unlisted: readonly string[];
}

/**
 * The documents the manifest claims to cover, found by walking rather than by listing.
 *
 * The manifest is the list of ceilings, so a document missing from it is invisible to an audit that only reads the
 * manifest: a new `docs/FOO.md` of any length would pass. This is the set that must be in it — the root documents and
 * the top level of `docs/` — and the subdirectories are the ones that are exempt on purpose: `docs/adr/` is a record of
 * decisions, `docs/agents/` is process, and `docs/research/` is evidence whose length belongs to its question.
 */
export function governedDocuments(base: string, manifest: Manifest): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(base, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".md")) found.push(entry.name);
	}
	try {
		for (const entry of readdirSync(join(base, "docs"), { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".md")) found.push(`docs/${entry.name}`);
		}
	} catch {
		// A directory with no `docs/` is a temporary one a test points at; there is nothing to govern.
	}
	return found.filter((file) => !manifest.generated.includes(file)).sort();
}

/** The words in a document, as a person counts them while reading it: whitespace-separated tokens. */
export function countWords(text: string): number {
	return text.split(/\s+/).filter((word) => word !== "").length;
}

/**
 * The manifest, validated.
 *
 * A ceiling that is not a positive integer is a typo rather than a budget, and a typo that silently reads as zero would
 * fail every file at once; so it is refused here, by name, instead of at the audit.
 */
export function readManifest(text: string, from = MANIFEST_PATH): Manifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${from} is not JSON: ${(error as Error).message}`);
	}
	const ceilings = (parsed as { ceilings?: unknown } | null)?.ceilings;
	if (typeof ceilings !== "object" || ceilings === null || Array.isArray(ceilings)) {
		throw new Error(`${from} has no "ceilings" object: {"ceilings": {"AGENTS.md": 2900}}`);
	}
	const checked: Record<string, number> = {};
	for (const [file, ceiling] of Object.entries(ceilings)) {
		if (typeof ceiling !== "number" || !Number.isInteger(ceiling) || ceiling <= 0) {
			throw new Error(`${from}: "${file}" has a ceiling of ${JSON.stringify(ceiling)}, not a positive whole number`);
		}
		checked[file] = ceiling;
	}
	const rawGenerated = (parsed as { generated?: unknown } | null)?.generated;
	if (rawGenerated !== undefined && !Array.isArray(rawGenerated)) {
		throw new Error(`${from}: "generated" must be a list of paths`);
	}
	const generated: string[] = [];
	for (const file of Array.isArray(rawGenerated) ? rawGenerated : []) {
		if (typeof file !== "string") throw new Error(`${from}: "generated" has a non-string entry`);
		if (file in checked) throw new Error(`${from}: "${file}" is generated and has a ceiling; pick one`);
		generated.push(file);
	}
	return { ceilings: checked, generated };
}

/**
 * The audit itself, against a directory: what a test can point at a temporary directory, and what the entry point
 * points at this repository. Every entry is read once, and a file that cannot be read is reported as missing rather than
 * thrown, so one renamed document does not hide the three others that are over.
 */
export function audit(manifest: Manifest, base: string): Audit {
	const rows: Row[] = [];
	const over: string[] = [];
	const missing: string[] = [];
	const unlisted: string[] = [];
	for (const [file, ceiling] of Object.entries(manifest.ceilings)) {
		let text: string;
		try {
			text = readFileSync(join(base, file), "utf8");
		} catch {
			missing.push(`${file} (listed with a ceiling of ${ceiling})`);
			continue;
		}
		const words = countWords(text);
		rows.push({ file, words, ceiling, headroom: ceiling - words });
		if (words > ceiling) over.push(`${file} (${words} words > ${ceiling})`);
	}
	for (const file of governedDocuments(base, manifest)) {
		if (!(file in manifest.ceilings)) unlisted.push(`${file} (no ceiling; add one at its current size)`);
	}
	return { rows, over, missing, unlisted };
}

function table(rows: readonly Row[]): string {
	const width = Math.max(4, ...rows.map((row) => row.file.length));
	const lines = [
		`${"file".padEnd(width)}  words  ceiling  headroom`,
		`${"-".repeat(width)}  -----  -------  --------`,
	];
	for (const row of rows) {
		const state = row.headroom < 0 ? `OVER by ${-row.headroom}` : String(row.headroom);
		lines.push(
			`${row.file.padEnd(width)}  ${String(row.words).padStart(5)}  ${String(row.ceiling).padStart(7)}  ${state}`,
		);
	}
	return lines.join("\n");
}

function main(): never {
	const check = process.argv.slice(2).includes("--check");
	let manifest: Manifest;
	try {
		manifest = readManifest(readFileSync(join(root, MANIFEST_PATH), "utf8"));
	} catch (error) {
		console.error(`[doc-budget] ${(error as Error).message}`);
		process.exit(1);
	}
	const { rows, over, missing, unlisted } = audit(manifest, root);
	const entries = rows.length + missing.length;
	if (!check) console.log(table(rows));
	for (const line of over) console.error(`[doc-budget] over budget: ${line}`);
	for (const line of missing) console.error(`[doc-budget] missing file: ${line}`);
	for (const line of unlisted) console.error(`[doc-budget] no ceiling: ${line}`);
	if (over.length === 0 && missing.length === 0 && unlisted.length === 0) {
		console.log(`[doc-budget] ${entries} files, all inside their ceilings`);
		process.exit(0);
	}
	console.error(
		`[doc-budget] ${entries} files, ${over.length} over budget, ${missing.length} missing and ${unlisted.length} with no ceiling: cut the words, or fix the entry in ${MANIFEST_PATH}`,
	);
	process.exit(1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
