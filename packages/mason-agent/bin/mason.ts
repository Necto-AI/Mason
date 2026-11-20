#!/usr/bin/env node
/**
 * `mason`, the one command the installed package answers with — and the only place the Node floor is enforced.
 *
 * Mason runs TypeScript from source and keeps its state in `node:sqlite`, and neither is there on a version below Node
 * 26.4. Without this file a run under an older Node dies inside a builtin, at the first thing a stranger ever does, with a
 * stack trace that names neither mason nor the version and no hint that installing Node again is the repair.
 *
 * The check has to run before the runtime is loaded, and an ESM import is evaluated before the first line of the module
 * that names it. So this file imports exactly one thing of its own — `./node-floor.ts`, which imports nothing at all —
 * and reaches the commands through a dynamic import that happens only after the version is allowed. Everything the
 * command does lives in `./cli.ts`, and `test/node-floor.test.ts` fails if a second relative import appears here.
 *
 * Two ways to find the command, because there are two layouts: a compiled install has `cli.js` beside this file in
 * `dist/bin`, and a checkout has only the source. The subcommand scripts already answer the same question the same way.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tooOld } from "./node-floor.ts";

const problem = tooOld(process.versions.node);
if (problem !== null) {
	console.error(problem);
	// Not 1: that is a doctor that found something, and this is mason declining to start. A wrapper can tell them apart.
	process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, "cli.js");
await import(pathToFileURL(existsSync(compiled) ? compiled : join(here, "cli.ts")).href);
