/**
 * `scripts/build-runtime.ts` — the build the published package ships.
 *
 * The vendoring is the part that quietly ships the wrong thing if it drifts, so the tests pin its two decisions: the
 * emitted module text is the only thing a workspace copy is vendored for (a quoted name that is not an import, like the
 * auth realm, moves no files), and the copy that ships is build output only, never TypeScript source.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { typescriptIn, vendoredNames } from "../scripts/build-runtime.ts";

const made: string[] = [];
after(async () => {
	for (const base of made) await rm(base, { recursive: true, force: true });
});

test("vendoredNames() reads imports, not every string a module happens to quote", () => {
	const imports = [
		'import { PROTOCOL_MAJOR } from "mason-protocol";',
		'import { createConnectorDoor } from "./connector.ts";',
		'import type { Origin } from "mason-protocol";',
		'const door = await import("mason-connector");',
		'import "mason-protocol";',
	];
	assert.deepEqual(vendoredNames(imports), ["mason-protocol", "mason-connector"]);
});

test("vendoredNames() leaves a quoted name that is no import alone", () => {
	// main.ts answers an unauthenticated socket with this realm; the name in it is prose, not an import.
	const realm = 'response.setHeader("www-authenticate", \'Bearer realm="mason-connector"\');';
	assert.deepEqual(vendoredNames([realm]), []);
});

test("typescriptIn() names source files and leaves declarations out, as prove:connector counts them", async () => {
	const base = await mkdtemp(join(tmpdir(), "mason-build-runtime-"));
	made.push(base);
	await mkdir(join(base, "dist", "deep"), { recursive: true });
	await writeFile(join(base, "dist", "index.js"), "export {};", "utf8");
	await writeFile(join(base, "dist", "index.d.ts"), "export {};", "utf8");
	await writeFile(join(base, "dist", "index.ts"), "export {};", "utf8");
	await writeFile(join(base, "dist", "deep", "leftover.ts"), "export {};", "utf8");
	assert.deepEqual(
		(await typescriptIn(join(base, "dist"))).map((path) => path.slice(base.length + 1)).sort(),
		[join("dist", "deep", "leftover.ts"), join("dist", "index.ts")],
		"a declaration is not source; the strays are named, the .js ignored",
	);
});
