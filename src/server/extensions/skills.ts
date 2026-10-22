/**
 * Skills: instructions the agent loads only when a task matches, so having many of them is cheap.
 *
 * The index is an index: a name, when to use it, and the absolute path of the file to read. Bodies are read on demand
 * with `read`, which is the whole reason a skill is a file and not prompt text.
 *
 * **The scan runs on the machine the tools run on.** `agent/skills/` is on the agent's own volume, and in the deployment
 * that volume is mounted into the tool machine and nowhere else; a scan with `node:fs` would work in the dev stack and
 * find nothing in the deployment. The root probe and the listing go through the execution environment for the same
 * reason the reads do.
 *
 * Two roots: the agent's own skills under `agent/skills/`, then the skills mason ships under `<repo>/skills/`. Own
 * first is what makes a personal skill shadow a shipped one without forking it.
 *
 * The scan is reused until a root's modification time moves, and the probe happens on every render: writing a skill is
 * meant to be enough to use it, including in the turn it was written in. The fingerprint includes the environment's
 * `id`, so one process serving two filesystems cannot answer with the other one's skills.
 *
 * Rendering is sorted by name and carries no timestamps or listing order: two renders of an unchanged home must be
 * byte-identical, or every turn appends a prompt delta and throws away the provider's prompt cache.
 */
import type { Context } from "@earendil-works/chord";
import {
	createSyntheticSourceInfo,
	formatSkillsForPrompt,
	parseFrontmatter,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { join } from "node:path";

/** Where the skills mason ships live. Resolved from this module, not from the process cwd. */
export const SHIPPED_SKILLS_DIR = join(import.meta.dirname, "../../../skills");

/** A directory that holds a `SKILL.md` is one skill, and is not scanned further. */
const SKILL_FILE = "SKILL.md";

/** How many directory levels below a root are scanned: skills nest by category, not by depth. */
const MAX_DEPTH = 6;

let cache: { readonly fingerprint: string; readonly skills: readonly Skill[] } | undefined;

/**
 * The skills under these roots, in root order and then by name, with a duplicate name resolved to the first root.
 *
 * A root that is not there contributes nothing: a fresh home has no `skills/` yet, and that is not a failure. Any other
 * failure throws, so the section keeps its previously shown text instead of claiming the agent has no skills.
 */
export async function discoverSkills(
	env: ExecutionEnv,
	roots: readonly string[],
	context: Context,
): Promise<readonly Skill[]> {
	const fingerprint = await rootsFingerprint(env, roots, context);
	if (cache !== undefined && cache.fingerprint === fingerprint) return cache.skills;

	const byName = new Map<string, Skill>();
	for (const root of roots) await scan(env, root, root, 0, context, byName);
	const skills = [...byName.values()].sort((left, right) =>
		left.name === right.name
			? left.filePath.localeCompare(right.filePath)
			: left.name.localeCompare(right.name),
	);
	cache = { fingerprint, skills };
	return skills;
}

/** A value that changes when the roots change: each root's modification time, or the fact that it is absent. */
async function rootsFingerprint(
	env: ExecutionEnv,
	roots: readonly string[],
	context: Context,
): Promise<string> {
	const probed: string[] = [env.id];
	for (const root of roots) {
		const info = await env.fileInfo(root, context);
		if (!info.ok) {
			if (info.error.code === "not_found") {
				probed.push(`${root}:absent`);
				continue;
			}
			throw new Error(`cannot scan ${root} on the machine the tools run on: ${info.error.message}`);
		}
		probed.push(`${root}:${info.value.mtimeMs}`);
	}
	return probed.join("\u0000");
}

/**
 * One directory: a `SKILL.md` in it is the skill and ends the walk, otherwise its subdirectories are scanned.
 *
 * Skips what is not a skill anywhere: dot directories, `node_modules`, and symbolic links (which are also how a scan
 * would walk in circles). A `.md` file directly below a root is a skill too, which is how a single-file skill is
 * written; below that, only `SKILL.md` counts.
 */
async function scan(
	env: ExecutionEnv,
	dir: string,
	root: string,
	depth: number,
	context: Context,
	byName: Map<string, Skill>,
): Promise<void> {
	const listing = await env.listDir(dir, context);
	if (!listing.ok) {
		if (listing.error.code === "not_found") return;
		throw new Error(`cannot scan ${dir} on the machine the tools run on: ${listing.error.message}`);
	}
	const entries = [...listing.value].sort((left, right) => left.name.localeCompare(right.name));
	if (entries.some((entry) => entry.name === SKILL_FILE && entry.kind === "file")) {
		const skill = await readSkill(env, join(dir, SKILL_FILE), context);
		if (skill !== undefined && !byName.has(skill.name)) byName.set(skill.name, skill);
		return;
	}
	if (depth >= MAX_DEPTH) return;
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.kind === "directory") {
			await scan(env, path, root, depth + 1, context, byName);
			continue;
		}
		if (entry.kind === "file" && dir === root && entry.name.endsWith(".md")) {
			const skill = await readSkill(env, path, context);
			if (skill !== undefined && !byName.has(skill.name)) byName.set(skill.name, skill);
		}
	}
}

/**
 * One skill file, or `undefined` when it has no description — pi's own rule, because a skill without one can never be
 * matched to a task and would only be noise in the index.
 *
 * The frontmatter is read by pi (`parseFrontmatter` inside `loadSkill` semantics): a file whose frontmatter does not
 * parse is not a skill. The name falls back to the directory, which is the label a person reads anyway.
 */
async function readSkill(env: ExecutionEnv, path: string, context: Context): Promise<Skill | undefined> {
	const text = await env.readTextFile(path, context);
	if (!text.ok) {
		if (text.error.code === "not_found") return undefined;
		throw new Error(`cannot read ${path} on the machine the tools run on: ${text.error.message}`);
	}
	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = parseFrontmatter<Record<string, unknown>>(text.value).frontmatter;
	} catch {
		// A file whose frontmatter does not parse is not a skill: pi refuses it for the same reason.
		return undefined;
	}
	const description = frontmatter.description;
	if (typeof description !== "string" || description.trim() === "") return undefined;
	const declared = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const baseDir = path.slice(0, path.lastIndexOf("/")) || "/";
	const name = declared === "" ? baseDir.slice(baseDir.lastIndexOf("/") + 1) : declared;
	return {
		name,
		description,
		filePath: path,
		baseDir,
		sourceInfo: createSyntheticSourceInfo(path, { source: "local", baseDir }),
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
	};
}

/**
 * The section text, rendered by pi — or `undefined` when there is nothing to say.
 *
 * pi's formatter returns an empty string for an empty list, and a section that returns `""` is still rendered: an
 * empty home would otherwise put `<skills>\n\n</skills>` in every prompt.
 */
export function renderSkills(skills: readonly Skill[]): string | undefined {
	if (skills.length === 0) return undefined;
	const text = formatSkillsForPrompt([...skills], "read").trim();
	return text === "" ? undefined : text;
}
