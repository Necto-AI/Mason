#!/usr/bin/env node
/**
 * Keeps `vendor/pi`'s own dependency tree intact across root installs.
 *
 * `scripts/link-vendor.mjs` links `vendor/pi/packages/*` into `node_modules/@earendil-works/*`. On the next
 * root `npm install` npm walks into those links, treats the linked packages as part of the root tree and prunes
 * the nested dependencies its own lock knows nothing about — which silently downgrades e.g. `openai` under
 * `packages/ai` and breaks vendor type-checking. This checks the nested entries of `vendor/pi`'s lockfile and
 * reinstalls them (`npm ci --ignore-scripts`, the same command `setup` uses) when they are gone.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorPi = join(root, "vendor", "pi");
const lockPath = join(vendorPi, "package-lock.json");

if (!existsSync(lockPath)) {
	console.log("[verify-vendor] vendor/pi is not checked out: run `git submodule update --init --recursive`.");
	process.exit(0);
}
if (!existsSync(join(vendorPi, "node_modules"))) {
	console.log("[verify-vendor] vendor/pi has no node_modules: run `setup` (devenv shell -- setup).");
	process.exit(0);
}

/** Workspace-nested lock entries (`packages/ai/node_modules/openai`), not the hoisted `node_modules/...` ones. */
function missingNestedEntries(lock) {
	const keys = Object.keys(lock.packages ?? {});
	return keys.filter((key) => !key.startsWith("node_modules/") && key.includes("/node_modules/"));
}

let missing;
try {
	missing = missingNestedEntries(JSON.parse(readFileSync(lockPath, "utf8"))).filter(
		(key) => !existsSync(join(vendorPi, key)),
	);
} catch (error) {
	console.log(`[verify-vendor] could not read vendor/pi's lockfile: ${error.message}`);
	process.exit(0);
}

if (missing.length === 0) {
	console.log("[verify-vendor] vendor/pi dependency tree is intact.");
	process.exit(0);
}

console.log(
	`[verify-vendor] vendor/pi is missing ${missing.length} nested dependency path(s) (${missing.slice(0, 3).join(", ")}${
		missing.length > 3 ? ", …" : ""
	}): reinstalling vendor/pi.`,
);
const result = spawnSync("npm", ["ci", "--ignore-scripts"], { cwd: vendorPi, stdio: "inherit" });
if (result.status !== 0) {
	console.error("[verify-vendor] vendor/pi reinstall failed; run `cd vendor/pi && npm ci --ignore-scripts` yourself.");
	process.exit(result.status ?? 1);
}
console.log("[verify-vendor] vendor/pi reinstalled.");
