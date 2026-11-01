#!/usr/bin/env node
/**
 * `biome` through its own shim, with one adjustment: on a NixOS machine the npm package's binary cannot start.
 *
 * The CLI package installs a prebuilt binary linked against the host's glibc (`Could not start dynamically linked
 * executable: …/cli-linux-x64/biome`, and NixOS has no `/lib64/ld-linux-x86-64.so.2` to give it). Biome also publishes a
 * statically linked musl build of the same version, and that one runs on NixOS, on Ubuntu in CI and everywhere else
 * without a loader. It is pinned in `optionalDependencies`, so a machine that cannot use it simply does not install it
 * and this script leaves biome's normal resolution alone.
 *
 * Both packages come from the same version in `package.json`, which is the point: the config and the formatter are the
 * same on a developer's machine and in CI, so "green here, red there" cannot come from a tool version.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shim = join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
const staticBuild = join(root, "node_modules", "@biomejs", "cli-linux-x64-musl", "biome");

if (!existsSync(shim)) {
	console.error("biome is not installed: run `npm install` (or `devenv shell -- setup`).");
	process.exit(1);
}

const env = { ...process.env };
if (existsSync(staticBuild)) env.BIOME_BINARY = staticBuild;

const result = spawnSync(process.execPath, [shim, ...process.argv.slice(2)], { stdio: "inherit", env });
process.exit(result.status ?? 1);
