/**
 * The line ratchet: what counts as a line of code, and what the audit refuses.
 *
 * The point of the ceiling is that it notices growth nobody argued for, so the tests here are about the edges — a
 * comment, a blank line, a test file, a directory that is gone — because those are the places a counter quietly lies.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { audit, countArea, countCode, governedAreas, readManifest } from "../scripts/code-budget.ts";

const made: string[] = [];

async function tree(files: Record<string, string>): Promise<string> {
	const base = await mkdtemp(join(tmpdir(), "mason-code-budget-"));
	made.push(base);
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(base, path, ".."), { recursive: true });
		await writeFile(join(base, path), text, "utf8");
	}
	return base;
}

after(async () => {
	for (const base of made) await rm(base, { recursive: true, force: true });
});

test("countCode() counts code, and nothing a reader skips", () => {
	const text = [
		"/**",
		" * A block comment.",
		" */",
		"import { thing } from './thing.ts';",
		"",
		"// one line of prose",
		"const a = 1;",
		"   ",
		"\tconst b = 2; /* trailing comments are still code */",
		"#!/usr/bin/env node",
	].join("\n");
	// The import, the two consts. The block comment's middle lines start with `*`, the first with `/*`, the shebang with
	// `#!`, and the rest are blank.
	assert.equal(countCode(text), 3);
});

test("countArea() skips tests, build output and dependencies", async () => {
	const base = await tree({
		"src/server/a.ts": "const a = 1;\nconst b = 2;\n",
		"src/server/b.tsx": "const c = 3;\n",
		"src/server/a.test.ts": "const test = 1;\n",
		"src/server/test/fixture.ts": "const fixture = 1;\n",
		"src/server/node_modules/dep.ts": "const dep = 1;\n",
		"src/server/dist/out.js": "const out = 1;\n",
		"src/server/readme.md": "not code\n",
	});
	assert.equal(countArea(base, "src/server"), 3, "three lines in the two source files, and nothing else");
});

test("governedAreas() finds the areas a manifest has to cover", async () => {
	const base = await tree({
		"src/server/a.ts": "const a = 1;\n",
		"src/web/a.ts": "const a = 1;\n",
		"packages/protocol/src/index.ts": "const a = 1;\n",
		"packages/client/README.md": "no src directory, so no area\n",
		"scripts/build.ts": "const a = 1;\n",
		"evals/run.ts": "const a = 1;\n",
	});
	assert.deepEqual(governedAreas(base), ["evals", "packages/protocol/src", "scripts", "src/server", "src/web"]);
});

test("audit() names the area that is over, the one that is gone, and the one nobody measured", async () => {
	const base = await tree({
		"src/server/a.ts": "const a = 1;\nconst b = 2;\n",
		"src/web/a.ts": "const a = 1;\n",
	});
	const manifest = readManifest(JSON.stringify({ ceilings: { "src/server": 1, "src/gone": 10 } }), "a test manifest");
	const report = audit(manifest, base);
	assert.deepEqual(report.over, ["src/server (2 lines > 1)"], "the area that grew past its number");
	assert.deepEqual(
		report.missing,
		["src/gone (listed with a ceiling of 10)"],
		"an entry whose directory is gone is a ceiling that stopped measuring anything",
	);
	assert.deepEqual(
		report.unlisted,
		["src/web (no ceiling; add one at its current size)"],
		"code that no ceiling covers is code nobody is measuring",
	);
});

test("readManifest() refuses a ceiling that is not a positive whole number", () => {
	assert.throws(() => readManifest(JSON.stringify({ ceilings: { "src/server": 0 } })), /positive whole number/);
	assert.throws(() => readManifest(JSON.stringify({ ceilings: { "src/server": 1.5 } })), /positive whole number/);
	assert.throws(() => readManifest(JSON.stringify({})), /no "ceilings" object/);
	assert.throws(() => readManifest("not json"), /is not JSON/);
});
