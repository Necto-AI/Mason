import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	APPROVAL,
	APPROVAL_META_KEY,
	CAPABILITIES,
	CONTROL_OPS,
	ERROR_CODE,
	METHOD,
	negotiateMinor,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	SCHEMA_ID,
	versionsCompatible,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, "..", "schemas", "protocol.v1.json"), "utf8")) as Record<
	string,
	unknown
>;

/** Every `$ref` in the document, wherever it is nested. */
function refs(node: unknown, found: string[] = []): string[] {
	if (Array.isArray(node)) {
		for (const item of node) refs(item, found);
		return found;
	}
	if (typeof node === "object" && node !== null) {
		for (const [key, value] of Object.entries(node)) {
			if (key === "$ref" && typeof value === "string") found.push(value);
			else refs(value, found);
		}
	}
	return found;
}

/** The document is the normative artifact: it has to be self-contained, or a connector in another language cannot read it. */
test("the schema is one self-contained document", () => {
	assert.equal(schema.$id, SCHEMA_ID);
	assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");

	const defs = schema.$defs as Record<string, unknown>;
	const dangling = refs(schema).filter((ref) => !Object.hasOwn(defs, ref.replace("#/$defs/", "")));
	assert.deepEqual(dangling, [], "a $ref points outside $defs");
});

test("every definition is named by a message and nothing is unnamed", () => {
	const defs = Object.keys(schema.$defs as Record<string, unknown>);
	assert.ok(defs.length > 20, "the document holds the whole protocol");
	for (const name of defs) assert.match(name, /^[a-zA-Z]+$/, `${name} is not a plain name`);
});

test("the error codes in the schema and in TypeScript are the same set", () => {
	const defs = schema.$defs as Record<string, Record<string, unknown>>;
	const codes = (defs.error.properties as Record<string, Record<string, unknown>>).code as { enum: string[] };
	assert.deepEqual([...codes.enum].sort(), [...Object.values(ERROR_CODE)].sort());
});

test("a method name is spelled once", () => {
	const names = Object.values(METHOD);
	assert.equal(new Set(names).size, names.length);
	for (const name of names) {
		const [namespace, rest] = name.split("/");
		assert.ok(namespace === "mason" || namespace === "connector", `${name} names no side`);
		assert.ok(rest !== undefined && rest.length > 0, `${name} has no method`);
	}
});

test("the protocol is major 1 and the enums agree with the schema", () => {
	assert.equal(PROTOCOL_MAJOR, 1);
	assert.equal(PROTOCOL_MINOR, 0);

	const defs = schema.$defs as Record<string, Record<string, unknown>>;
	const capability = (defs.capability as { enum: string[] }).enum;
	assert.deepEqual([...CAPABILITIES].sort(), [...capability].sort());

	const control = defs.controlParams.properties as Record<string, { enum: string[] }>;
	assert.deepEqual([...CONTROL_OPS].sort(), [...control.op.enum].sort());

	const ack = defs.deliveryAck.properties as Record<string, { enum: string[] }>;
	assert.deepEqual(ack.status.enum, ["delivered", "duplicate", "uncertain", "rejected"]);

	// The content union, by its tags: a variant deleted from the type and left in the schema is a consumer validating
	// against this file accepting a block mason can never send.
	const blocks = (defs.block as { oneOf: { properties?: { type?: { const?: string } } }[] }).oneOf;
	const tags = blocks.map((block) => block.properties?.type?.const);
	assert.deepEqual(tags, ["text", "markdown", "file", "notice"]);
});

test("the approval marker is namespaced and has exactly two values", () => {
	assert.equal(APPROVAL_META_KEY, "dev.mason/approval");
	assert.deepEqual(Object.values(APPROVAL).sort(), ["not_required", "required"]);
});

test("version negotiation: a major is all or nothing, a minor is the highest both sides know", () => {
	assert.equal(versionsCompatible({ major: 1 }), true);
	assert.equal(versionsCompatible({ major: 2 }), false);
	assert.equal(negotiateMinor({ major: 1 }), 0);
	assert.equal(negotiateMinor({ major: 1, minors: [0, 3] }, { major: 1, minors: [0, 2] }), 0);
	assert.equal(negotiateMinor({ major: 1, minors: [0, 2] }, { major: 1, minors: [0, 1, 2] }), 2);
	assert.equal(negotiateMinor({ major: 1, minors: [5] }, { major: 1, minors: [0] }), 0);
});
