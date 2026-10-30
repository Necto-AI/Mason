/**
 * What an integration's code may contribute, and what refuses the boot.
 *
 * The mechanism is small on purpose and everything that matters here is a refusal: a name that is not an integration
 * name, a key this build does not read, an API newer than the build, a section key the prompt already owns, two
 * integrations rendering under one tag. Each of those is a way a contribution could otherwise arrive half-read, which
 * is the failure mode ADR-0009 exists to close.
 *
 * The prompt half is tested against `promptSections()` rather than the built list, because `INTEGRATIONS` is empty until
 * the chat's own knowledge moves in: this is the function that will run with it, so this is where its placement, order
 * and cap are pinned.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptSection } from "@earendil-works/pi-durable";
import {
	defineIntegration,
	HOST,
	install,
	INTEGRATIONS,
	type InstalledIntegration,
	type IntegrationContribution,
} from "../src/integrations/index.ts";
import { BUILTIN_SECTION_KEYS, promptSectionKeys, promptSections } from "../src/server/prompt.ts";

/** The prompt's own keys, which is what a contribution is checked against. */
const RESERVED = { reservedKeys: BUILTIN_SECTION_KEYS };

const chat: IntegrationContribution = defineIntegration({
	name: "slack",
	host: HOST,
	sections: [{ key: "slack", text: "Slack is the team's room. Answer in one paragraph." }],
});

/** The refusal a contribution earns, as the operator reads it. */
function refusal(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	assert.fail("the contribution was accepted, so it would have been rendered or ignored rather than refused");
}

/** A contributed section as it reaches the system prompt: tagged, the way `renderSections` wraps it. */
async function render(promptSection: PromptSection): Promise<string> {
	const text = await promptSection.render({} as never, BACKGROUND_CONTEXT as never);
	return promptSection.tag === false ? (text ?? "") : `<${promptSection.key}>\n${text}\n</${promptSection.key}>`;
}

test("an empty list installs nothing, which is what this build ships", () => {
	assert.deepEqual(install([], RESERVED), []);
	assert.deepEqual(INTEGRATIONS, [], "INTEGRATIONS is the closed list; a directory with no line here is dead code");
	assert.deepEqual(
		promptSectionKeys(),
		BUILTIN_SECTION_KEYS,
		"no contribution is installed yet, so the prompt is its own sections; when the first one lands, its key " +
			"belongs in the pinned list in prompt.test.ts",
	);
});

test("installs a contribution and hands back its sections in declaration order", () => {
	const installed = install([chat], RESERVED);
	assert.deepEqual(installed, [
		{ name: "slack", sections: [{ key: "slack", text: "Slack is the team's room. Answer in one paragraph." }] },
	]);
});

test("installs a contribution that adds no prompt text", () => {
	const installed = install([defineIntegration({ name: "sentry", host: HOST })], RESERVED);
	assert.deepEqual(installed, [{ name: "sentry", sections: [] }]);
});

test("refuses a contribution this build cannot read, naming what is wrong", () => {
	const cases: ReadonlyArray<{ why: string; contribution: unknown; names: RegExp }> = [
		{
			why: "a name a tool cannot be built from",
			contribution: { name: "my_chat", host: HOST },
			names: /is not a usable name/,
		},
		{
			why: "no name at all",
			contribution: { host: HOST },
			names: /\(unnamed\) is not a usable name/,
		},
		{
			why: "no host",
			contribution: { name: "slack" },
			names: /declares no usable "host"/,
		},
		{
			why: "a host that is not an integer",
			contribution: { name: "slack", host: "1" },
			names: /declares no usable "host"/,
		},
		{
			why: "an API newer than the build, which is the whole point of the number",
			contribution: { name: "slack", host: HOST + 1 },
			names: new RegExp(`written against integration API ${HOST + 1}; this build is ${HOST}`),
		},
		{
			why: "a key this build does not read",
			contribution: { name: "slack", host: HOST, description: "a line from a later version" },
			names: /has the key "description", which this build does not read/,
		},
	];
	for (const { why, contribution, names } of cases) {
		const message = refusal(() => install([contribution as IntegrationContribution], RESERVED));
		assert.match(message, names, `${why}: ${message}`);
	}
});

/**
 * The half of the surface the design names and the code does not have. Each is refused by name rather than ignored,
 * because a field an integration declared and mason skipped is a promise nobody kept — the failure the config entry had
 * one layer down.
 */
test("refuses a contribution using a field that arrives with its code", () => {
	for (const key of ["tools", "hooks", "commands", "close", "trust"]) {
		const contribution = { name: "slack", host: HOST, [key]: {} } as unknown as IntegrationContribution;
		const message = refusal(() => install([contribution], RESERVED));
		assert.match(message, new RegExp(`contributes "${key}", which is part of the contribution API`), `${key}: ${message}`);
	}
});

test("refuses two integrations under one name", () => {
	const message = refusal(() => install([chat, chat], RESERVED));
	assert.match(message, /"slack" is listed twice/);
});

test("refuses a section key the prompt already owns", () => {
	const borrowed = defineIntegration({ name: "slack", host: HOST, sections: [{ key: "delivery", text: "mine" }] });
	const message = refusal(() => install([borrowed], RESERVED));
	assert.match(message, /renders under "<delivery>", which the prompt already has/);
});

test("refuses two integrations rendering under one tag", () => {
	const one = defineIntegration({ name: "slack", host: HOST, sections: [{ key: "chat", text: "slack" }] });
	const two = defineIntegration({ name: "telegram", host: HOST, sections: [{ key: "chat", text: "telegram" }] });
	const message = refusal(() => install([one, two], RESERVED));
	assert.match(message, /integration "telegram" section 1 renders under "<chat>"/);
});

test("refuses a section that is not a tag name, and one with no text", () => {
	const bad = defineIntegration({
		name: "slack",
		host: HOST,
		sections: [{ key: "slack.chat", text: "x" }],
	});
	assert.match(refusal(() => install([bad], RESERVED)), /has no usable key \("slack\.chat"\)/);

	const empty = defineIntegration({ name: "slack", host: HOST, sections: [{ key: "slack", text: "   " }] });
	assert.match(refusal(() => install([empty], RESERVED)), /has no text/);

	const extra = defineIntegration({
		name: "slack",
		host: HOST,
		sections: [{ key: "slack", text: "x", position: 1 } as never],
	});
	assert.match(refusal(() => install([extra], RESERVED)), /section "slack" has the key "position"/);
});

const installed: readonly InstalledIntegration[] = install(
	[
		defineIntegration({
			name: "telegram",
			host: HOST,
			sections: [{ key: "telegram", text: "Telegram is Denis's phone. Answer short." }],
		}),
		chat,
	],
	RESERVED,
);

test("a contributed section renders under its own tag, after the integrations pointer", async () => {
	const sections = promptSections(installed);
	const keys = sections.map((promptSection) => promptSection.key);
	assert.equal(keys[keys.indexOf("integrations") + 1], "slack", "contributed text sits beside the list that names it");
	assert.equal(keys[keys.indexOf("slack") + 1], "telegram", "contributed sections sort by integration name");
	assert.ok(keys.indexOf("telegram") < keys.indexOf("codemode"), "and before the tools a script can call");
	assert.equal(keys.at(-1), "delivery", "the delivery rule stays the prompt's last word");

	const slack = sections.find((promptSection) => promptSection.key === "slack");
	assert.ok(slack);
	assert.equal(
		await render(slack),
		"<slack>\nSlack is the team's room. Answer in one paragraph.\n</slack>",
		"the integration supplies text, and the tag is the prompt's",
	);
});

test("a contributed section renders the same bytes on every turn", async () => {
	const slack = promptSections(installed).find((promptSection) => promptSection.key === "slack");
	assert.ok(slack);
	assert.equal(await render(slack), await render(slack), "a contribution cannot re-price the prefix between two turns");
});

test("a section over the budget is capped where the prompt can see it", async () => {
	const long = defineIntegration({
		name: "slack",
		host: HOST,
		sections: [{ key: "slack", text: "x".repeat(601) }],
	});
	const slack = promptSections(install([long], RESERVED)).find((promptSection) => promptSection.key === "slack");
	assert.ok(slack);
	const text = await render(slack);
	assert.match(text, /\(truncated at 600 characters\)/, "an operator reads that their paragraph was cut");
});
