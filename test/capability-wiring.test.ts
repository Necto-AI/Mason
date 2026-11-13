/**
 * A capability the repository says it ships has to be somewhere a test can find it.
 *
 * Each capability mason claims has its own done-criterion: one test in this repository fails if it disappears. Nothing in
 * a running bot proves that, so these read the files that wire each capability in and pin the parts a person would have
 * to delete to remove it.
 *
 * They are deliberately about *presence and shape*, not about behaviour: behaviour is measured where it lives. What is
 * pinned here is that mason still asks for it.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const root = new URL("../", import.meta.url).pathname;

const read = (path: string) => readFile(join(root, path), "utf8");

test("the ocr skill ships with mason, so every bot gets it without a person copying a file", async () => {
	const skill = await read("skills/ocr/SKILL.md");
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(skill);
	assert.equal(frontmatter.name, "ocr");
	assert.match(String(frontmatter.description), /indra-ocr/, "the skill names the binary it is about");
	assert.match(skill, /indra-ocr <path> --format md/, "and shows the call");
});
