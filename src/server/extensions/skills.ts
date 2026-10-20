/**
 * Skills: instructions the agent loads only when a task matches, so having many of them is cheap.
 *
 * The prompt carries an index — name, when to use it, where it lives — and never the bodies. A skill is a directory
 * with a `SKILL.md`, in the same format as `~/dev/pi-setup/skills`: YAML frontmatter with `name` and `description`,
 * then markdown. Nesting is allowed (`engineering/pr/SKILL.md`), because grouping skills is how a person keeps them.
 *
 * Two roots, one index: the skills mason ships under `<repo>/skills/`, and Denis's own under `~/.mason/skills/`. A
 * personal skill with the same name shadows a shipped one — that is how you change a default without forking it, and
 * no install step is involved.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { currentHouse } from "../house.ts";

export interface Skill {
	readonly name: string;
	readonly description: string;
	/** Absolute path to the `SKILL.md`, so the model can `read` it from any cwd. */
	readonly location: string;
}

/** Where the skills mason ships live. Resolved from this module, not from the process cwd. */
export const SHIPPED_SKILLS_DIR = join(import.meta.dirname, "../../../skills");

function frontmatter(text: string): { fields: Record<string, string>; body: string } {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	if (match === null) return { fields: {}, body: text };
	const fields: Record<string, string> = {};
	for (const line of (match[1] ?? "").split("\n")) {
		const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (pair === null) continue;
		fields[pair[1] as string] = (pair[2] ?? "").replace(/^["']|["']$/g, "").trim();
	}
	return { fields, body: match[2] ?? "" };
}

/** Every `SKILL.md` under a root, at any depth. A missing root is not an error: it just has no skills. */
async function findSkillFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	async function walk(directory: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && entry.name === "SKILL.md") found.push(path);
		}
	}
	await walk(root);
	return found.sort();
}

async function skillsIn(root: string): Promise<Skill[]> {
	const skills: Skill[] = [];
	for (const path of await findSkillFiles(root)) {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			continue;
		}
		const { fields } = frontmatter(text);
		// The skill's own directory is the fallback name: a folder is already the label a person reads.
		const name = fields.name ?? basename(dirname(path));
		const description = fields.description ?? "";
		if (name === "") continue;
		skills.push({ name, description, location: path });
	}
	return skills;
}

/**
 * The index, personal first so a shadowing skill appears where a reader expects it, then everything else.
 *
 * The wording is pi's own skills prompt (`formatSkillsForPrompt` in the coding agent) reduced to the shape that
 * matters: names, "use this when", and the path to read.
 */
export async function discoverSkills(
	shippedRoot = SHIPPED_SKILLS_DIR,
	personalRoot = currentHouse().skillsDir,
): Promise<Skill[]> {
	const personal = await skillsIn(personalRoot);
	const shipped = await skillsIn(shippedRoot);
	const taken = new Set(personal.map((skill) => skill.name));
	return [...personal, ...shipped.filter((skill) => !taken.has(skill.name))];
}

export function renderSkills(skills: readonly Skill[]): string {
	if (skills.length === 0) return "";
	const lines = [
		"You have skills: written instructions for work you will do more than once. Read one with `read` when a task",
		"matches its description, and follow it; the index below carries only names, so nothing is in context until",
		"you ask for it.",
		"",
	];
	for (const skill of skills) {
		lines.push(`- ${skill.name} — ${skill.description === "" ? "(no description)" : skill.description}`);
		lines.push(`  ${skill.location}`);
	}
	return lines.join("\n");
}

export const Skills = defineExtension({
	name: "skills",
	sections: [section("skills", async () => renderSkills(await discoverSkills()))],
});
