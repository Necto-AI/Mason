/**
 * Skills: instructions the agent loads only when a task matches, so having many of them is cheap.
 *
 * Nothing here parses a skill. pi already owns the format — `loadSkills` scans each root, reads frontmatter, validates
 * names and descriptions, honours ignore files, resolves collisions between roots (first root wins, later duplicates
 * become diagnostics) and dedupes symlinked copies; `formatSkillsForPrompt` renders the block the model reads,
 * including the "read the file when the task matches" instruction. This module decides only *which roots* to scan.
 *
 * Two roots: Denis's own skills under `~/.mason/skills/`, then the skills mason ships under `<repo>/skills/`. Personal
 * first is what makes a personal skill shadow a shipped one without forking it.
 *
 * `includeDefaults: false` is deliberate. pi's defaults would also index `<cwd>/.pi/skills` — whatever project the
 * agent happens to be running in — and a personal assistant's prompt must not depend on that.
 */
import { join } from "node:path";
import { formatSkillsForPrompt, loadSkills, type Skill } from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { currentHouse } from "../house.ts";

/** Where the skills mason ships live. Resolved from this module, not from the process cwd. */
export const SHIPPED_SKILLS_DIR = join(import.meta.dirname, "../../../skills");

export function discoverSkills(shippedRoot = SHIPPED_SKILLS_DIR, personalRoot = currentHouse().skillsDir): Skill[] {
	const home = currentHouse().home;
	return loadSkills({
		cwd: home,
		agentDir: home,
		skillPaths: [personalRoot, shippedRoot],
		includeDefaults: false,
	}).skills;
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

export const Skills = defineExtension({
	name: "skills",
	sections: [section("skills", () => renderSkills(discoverSkills()))],
});
