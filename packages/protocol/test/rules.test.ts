/**
 * The rules the protocol states about itself, walked over the module that states them.
 *
 * Two of them were prose that nothing read. Rule 9 says an object that crosses this wire is open, so that a field a newer
 * peer added is ignored rather than refused — and five objects were closed, which is exactly the kind of exception that
 * becomes permanent at the first tag. And the error table in `PROTOCOL.md` is what a connector author branches on; a code
 * the module raises and the document never names is an error nobody can handle, and a row with no code behind it is a
 * connector waiting for a refusal that cannot arrive.
 *
 * Neither can be checked by reading harder, so both are checked here, by walking: every schema this module exports, and
 * the table's `mason.*` rows against `ERROR_CODE`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as protocol from "../src/index.ts";

/** Every `*Schema` this module exports: the shapes a peer validates, by the name a connector writes. */
function exportedSchemas(): Array<readonly [string, unknown]> {
	return Object.entries(protocol).filter(([name, value]) => name.endsWith("Schema") && typeof value === "object");
}

/** Where rule 9 is broken, as `SchemaName.path.to.the.object`: the name is what a reader has to open. */
function closedObjects(node: unknown, path: string, found: string[]): void {
	if (Array.isArray(node)) {
		for (const item of node) closedObjects(item, path, found);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const schema = node as Readonly<Record<string, unknown>>;
	if (schema.type === "object" && schema.additionalProperties === false) found.push(path);
	for (const [keyword, value] of Object.entries(schema)) closedObjects(value, `${path}.${keyword}`, found);
}

test("every object a peer validates is open, because major 1 is additions only", () => {
	const broken: string[] = [];
	for (const [name, schema] of exportedSchemas()) closedObjects(schema, name, broken);
	assert.deepEqual(
		broken,
		[],
		"rule 9 of PROTOCOL.md: an object a peer validates is open, or the next field it adds is refused. " +
			"Annotate the object with `{ open: true }`.",
	);
	// A schema named here but never exported would pass the walk by not existing: the two lists have to be the same list.
	assert.ok(exportedSchemas().length >= 10, "the exported schemas were not read, so nothing above was checked");
});

test("the error table is the code set, both ways", () => {
	const prose = readFileSync(new URL("../PROTOCOL.md", import.meta.url), "utf8");
	const documented = [...prose.matchAll(/^\|\s*`(mason\.[a-z_]+)`\s*\|/gm)].map((match) => match[1] as string);
	assert.deepEqual(
		[...new Set(documented)].sort(),
		[...Object.values(protocol.ERROR_CODE)].sort(),
		"PROTOCOL.md's error table and ERROR_CODE are one list: a code with no row is an error nobody can handle, and a " +
			"row with no code is a refusal that cannot arrive",
	);
});
