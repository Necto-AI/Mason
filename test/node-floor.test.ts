/**
 * `bin/node-floor.ts` — the version mason refuses to start under, and the one import the entry point may have.
 *
 * The floor is the renderer's (`@opentui/core` reaches `node:ffi`, absent below 26.4) and it can only be enforced by
 * code that runs on the version being refused. That is why the interesting test here is the second one: the check is
 * worthless if the module holding it grows an import, because ESM evaluates an import before the line that would have
 * printed the refusal. A future edit that adds `import { … } from "../src/…"` to `bin/mason.ts` would pass a review and
 * silently turn every old-Node run back into `ERR_UNKNOWN_BUILTIN_MODULE`, so the shape is pinned, not described.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ffiFlags, NODE_FLOOR, tooOld } from "../bin/node-floor.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the floor is the renderer's, and it is one version for everything", () => {
	assert.equal(NODE_FLOOR, "26.4.0");
});

test("a version at the floor or above runs, and one below it is refused by name", () => {
	assert.equal(tooOld("26.4.0"), null, "the floor itself is supported");
	assert.equal(tooOld("26.4.1"), null);
	assert.equal(tooOld("26.11.1"), null, "the Node the devenv shell provides");
	assert.equal(tooOld("27.0.0"), null, "nothing pins an upper bound");
	assert.equal(tooOld("v26.4.0"), null, "the leading v is a version string, not a different release");

	for (const old of ["26.3.9", "26.0.0", "24.22.2", "22.19.0", "20.11.0"]) {
		const problem = tooOld(old);
		assert.notEqual(problem, null, `${old} is below the floor`);
		assert.match(problem as string, /needs Node\.js 26\.4\.0 or newer/);
		assert.ok((problem as string).includes(old), "the refusal says which version is running");
		assert.match(problem as string, /node:ffi/, "it says why, so the version is not mistaken for a hard preference");
		assert.match(problem as string, /nvm install 26/, "it names a repair");
	}
});

test("a version this check cannot read is refused rather than allowed", () => {
	// The floor exists because a version below it fails somewhere unhelpful; an unreadable string is not a promise
	// that the version is recent, and guessing "probably fine" is the failure this check was written to end.
	const problem = tooOld("not-a-version");
	assert.notEqual(problem, null);
	assert.match(problem as string, /cannot read this Node's version/);
});

test("the entry point imports node-floor and node builtins, and nothing else", () => {
	const source = readFileSync(join(root, "bin", "mason.ts"), "utf8");
	const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);

	assert.ok(specifiers.length > 0, "the entry point imports something; an unparsed file would pass an empty check");
	for (const specifier of specifiers) {
		const allowed = specifier?.startsWith("node:") === true || specifier === "./node-floor.ts";
		assert.ok(allowed, `${specifier} is loaded before the guard that refuses an old Node`);
	}
	assert.ok(specifiers.includes("./node-floor.ts"), "the guard is the one relative import");
});

test("node-floor itself imports nothing, so it is safe on the version it refuses", () => {
	const source = readFileSync(join(root, "bin", "node-floor.ts"), "utf8");
	assert.doesNotMatch(source, /^\s*import\s/m, "an import here would be evaluated before the check that reads it");
	assert.doesNotMatch(source, /^\s*export\s[^;]*from\s/m, "a re-export is an import with a friendly name");
});

test("the renderer's flag is handed to a child exactly where node:ffi is still opt-in", () => {
	// node:ffi arrived in 26.1 behind --experimental-ffi and became default-on in 26.9. The floor is 26.4, so every
	// supported version below 26.9 needs the flag and every version from 26.9 does not.
	for (const needs of ["26.4.0", "26.4.1", "26.8.2", "v26.5.0"]) {
		assert.deepEqual(ffiFlags(needs), ["--experimental-ffi"], `${needs} still needs the flag`);
	}
	for (const free of ["26.9.0", "26.11.1", "27.0.0", "28.1.0", "24.22.2"]) {
		assert.deepEqual(ffiFlags(free), [], `${free} does not`);
	}
	assert.deepEqual(ffiFlags("not-a-version"), [], "an unreadable version adds no flag rather than a wrong one");
});
