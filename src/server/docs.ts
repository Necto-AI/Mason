/**
 * The reference the agent reads about its own deployment, and the one place a document can grow without costing a token.
 *
 * The prompt has a ceiling, and every sentence in it is paid again on every turn; a connector that needs three paragraphs
 * of explanation cannot have them. So the explanation is a page on the tool machine instead — `/mason/docs/`, mounted
 * read-only by whoever serves it — and the prompt carries an index of it, one line per page.
 *
 * Read-only is the point, not a preference: the agent the reference is meant to correct is the same process that could
 * otherwise rewrite it, and a page the agent wrote would be read back as the machine's own truth. So nothing here copies
 * anything into the home, and the agent's half of it stays the agent's.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The pages mason ships, in the repository — the directory `DOCS_MOUNT` is served from. */
export const SHIPPED_DOCS_DIR = fileURLToPath(new URL("../../docs/agent/", import.meta.url));

/** The path the prompt names: where a tool machine sees the pages. */
export const DOCS_MOUNT = "/mason/docs";

/** One page of the reference: its path inside the mount, and the first heading that says what it is. */
export interface DocPage {
	readonly path: string;
	readonly title: string;
}

/**
 * The pages mason ships, README first and then alphabetical.
 *
 * Read from the server's side of the same directory the tool machine mounts, because the index is rendered by the server
 * and the mount is a deployment detail — a page the package does not carry is a page the index does not offer.
 */
export async function readDocsIndex(docsDir = SHIPPED_DOCS_DIR): Promise<DocPage[]> {
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
