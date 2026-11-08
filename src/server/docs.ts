/**
 * The reference the agent reads about its own deployment, and the one place a document can grow without costing a token.
 *
 * The prompt has a ceiling, and every sentence in it is paid again on every turn; a connector that needs three paragraphs
 * of explanation cannot have them. So the explanation is a file on the tool machine instead — `agent/docs/` — and the
 * prompt carries an index of it, one line per page.
 *
 * The pages are mason's, not the agent's: they live in this repository (`docs/agent/`), they are copied into the home on
 * every boot, and an edit made in the home is overwritten. That is the difference between this and a skill: a skill is
 * the agent's own instruction and an edit wins, a document that describes the machine and the wire has to describe the
 * version that is running.
 */
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The pages mason ships, in the repository. */
export const SHIPPED_DOCS_DIR = fileURLToPath(new URL("../../docs/agent/", import.meta.url));

/** One page of the reference: its path inside `agent/docs/`, and the first heading that says what it is. */
export interface DocPage {
	readonly path: string;
	readonly title: string;
}

/**
 * Copy the shipped pages into the agent's half, replacing whatever was there.
 *
 * No record and no hashes: unlike a skill, nothing here belongs to the agent. The whole directory is rewritten, so a page
 * the repository stops shipping stops existing on the machine that has the old one.
 */
export async function seedShippedDocs(agentDir: string, shippedDir = SHIPPED_DOCS_DIR): Promise<void> {
	const target = join(agentDir, "docs");
	await rm(target, { recursive: true, force: true });
	await mkdir(dirname(target), { recursive: true });
	await cp(shippedDir, target, { recursive: true, force: true }).catch((error: unknown) => {
		// A deployment whose image does not carry the pages is not a server that cannot boot: the prompt then lists no
		// pages, and the agent reads a reference that is not there rather than a boot that refuses.
		if ((error as { code?: string }).code === "ENOENT") return;
		throw error;
	});
}

/**
 * The pages present in the home, README first and then alphabetical.
 *
 * Read from the home rather than from the repository for the same reason skills are: the prompt is rendered in the
 * deployment, and the tool machine has the home. A page that failed to seed is a page the index does not offer.
 */
export async function readDocsIndex(docsDir: string): Promise<DocPage[]> {
	const pages: DocPage[] = [];
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!entry.name.endsWith(".md")) continue;
			pages.push({ path: relative(docsDir, full), title: titleOf(await readTitle(full)) });
		}
	};
	await walk(docsDir);
	return pages.sort((left, right) => rank(left) - rank(right) || left.path.localeCompare(right.path));
}

/** README first, then the pages beside it, then the per-service ones: the order a person meeting this would read it. */
function rank(page: DocPage): number {
	if (page.path === "README.md") return 0;
	return page.path.includes("/") ? 2 : 1;
}

async function readTitle(path: string): Promise<string> {
	const text = await readFile(path, "utf8").catch(() => "");
	return (
		text
			.split("\n")
			.find((line) => line.startsWith("# "))
			?.slice(2) ?? ""
	);
}

/** A heading is a sentence about the page, not a page of its own: the index is one line per file. */
function titleOf(title: string): string {
	const trimmed = title.trim();
	if (trimmed.length <= 72) return trimmed;
	return `${trimmed.slice(0, 69).trimEnd()}...`;
}
