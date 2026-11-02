#!/usr/bin/env node
// Bundles the operator panel (`src/web/admin/main.tsx`) into `dist/web/`, copying `index.html` beside it.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src", "web");
const outdir = join(root, "dist", "web");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await esbuild.build({
	entryPoints: [join(src, "admin", "main.tsx")],
	bundle: true,
	outfile: join(outdir, "admin.js"),
	format: "esm",
	platform: "browser",
	target: ["es2022"],
	sourcemap: true,
	jsx: "automatic",
	loader: { ".css": "css" },
	// React and every `@earendil-works/*` package are inside the repo, so they bundle; the conditions match how
	// the server runs them (source, not dist).
	conditions: ["source", "import", "browser", "default"],
	define: { "process.env.NODE_ENV": '"production"' },
	logLevel: "info",
	metafile: true,
});

if (result.errors.length > 0) {
	for (const error of result.errors) console.error(error);
	process.exit(1);
}

const html = await readFile(join(src, "index.html"), "utf8");
const cssFile = (result.metafile?.outputs ? Object.keys(result.metafile.outputs) : []).find((path) =>
	path.endsWith(".css"),
);
// esbuild writes the extracted CSS beside the bundle but never links it: the HTML must, and this catches drift.
const linked = html.match(/<link[^>]+href="\.\/(admin\.css)"[^>]*>/);
if (linked === null) throw new Error("src/web/index.html does not link the bundled stylesheet (./admin.css)");
// The bundle and the sheet are the two files the shell names; a name that drifts here is a blank page in a browser.
const scripted = html.match(/<script[^>]+src="\.\/(admin\.js)"[^>]*>/);
if (scripted === null) throw new Error("src/web/index.html does not load the bundled script (./admin.js)");
await writeFile(join(outdir, "index.html"), html);
if (cssFile === undefined && existsSync(join(outdir, "admin.css")))
	throw new Error("stylesheet emitted but not linked");
console.log(`operator panel -> ${outdir} (${cssFile ?? "no css"})`);
