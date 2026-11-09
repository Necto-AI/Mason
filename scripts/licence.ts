/**
 * `npm run check:licence` — one licence, stated the same way everywhere it is stated.
 *
 * A repository can carry a single licence and still publish two. The manifests, the README, the licence text and NOTICE
 * are four places a reader meets the terms, and they are edited at different times: mason's drifted, with NOTICE
 * claiming Apache-2.0 for the three published packages while every manifest, the README and LICENSE said AGPL-3.0. A
 * connector author reading the repository would have built against the wrong one, and a comment saying "the licence"
 * does not fail when it stops being true.
 *
 * This is the check that fails instead. It reads the files as a consumer receives them and names every disagreement.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** The one spelling the manifests use, and the one the README has to name. */
export const LICENCE = "AGPL-3.0-only";

/** The packages this repository publishes, and the tarballs a consumer's terms arrive in. */
const MANIFESTS = ["package.json", "packages/protocol/package.json", "packages/connector/package.json"] as const;

/** The per-package copies npm puts in a tarball: a LICENSE beside the package.json, not one three directories up. */
const COPIES = ["packages/protocol/LICENSE", "packages/connector/LICENSE"] as const;

const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** Every disagreement, in the order a reader meets them. Empty is the pass. */
export function disagreements(): string[] {
	const problems: string[] = [];
	for (const path of MANIFESTS) {
		const manifest = JSON.parse(read(path)) as { license?: unknown };
		if (manifest.license !== LICENCE) {
			problems.push(`${path}: license is ${String(manifest.license)}, not ${LICENCE}`);
		}
	}
	if (!read("README.md").includes(LICENCE)) problems.push(`README.md does not name ${LICENCE}`);
	const licence = read("LICENSE");
	if (!licence.includes("GNU AFFERO GENERAL PUBLIC LICENSE") || !licence.includes("Version 3")) {
		problems.push("LICENSE is not the GNU Affero General Public License, version 3");
	}
	for (const copy of COPIES) {
		if (read(copy) !== licence) problems.push(`${copy} is not the repository's LICENSE`);
	}
	const notice = read("NOTICE");
	if (/Apache License/i.test(notice)) problems.push("NOTICE still names the Apache License");
	if (!/GNU Affero General Public License/i.test(notice)) {
		problems.push("NOTICE does not name the GNU Affero General Public License");
	}
	return problems;
}

const problems = disagreements();
if (problems.length > 0) {
	for (const problem of problems) console.error(`[licence] ${problem}`);
	process.exit(1);
}
console.log(`[licence] ${MANIFESTS.length} manifests, README, LICENSE, both package copies and NOTICE say ${LICENCE}`);
