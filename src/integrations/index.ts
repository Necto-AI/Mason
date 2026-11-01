/**
 * The code an integration brings, and the one place it is listed.
 *
 * ADR-0003 made an integration a service: a container, a config entry and a secret. That is the shape for code mason
 * does not trust, and this module does not change it — a third party still gets a process, MCP for tools and one signed
 * POST for events, and nothing else. What a config entry cannot say is everything a chat needs beyond tools: the
 * operator's paragraph about the medium, where a reply goes, a row in the reader's transcript, and the lifecycle of a
 * resource the integration owns. Their author is the person who runs this box, not a remote server, so they cannot
 * arrive over a protocol (`docs/adr/0009-an-integration-may-bring-code.md`).
 *
 * So an integration may also be a contribution: a data-first object — a name, the API it was written against, and the
 * prompt sections it adds — validated once by `install()` before the first turn. Three things make it a mechanism
 * rather than a plugin directory:
 *
 * - `defineIntegration()` is what an integration's own module returns, so the array below is typed by what it accepts.
 * - `INTEGRATIONS` is the closed list. A directory with no line here is dead code, not a contribution, and there is no
 *   glob and no import by convention (`docs/adr/0007-capabilities-are-listed-once-in-code.md` §6).
 * - `install()` is the only validator, and it owns the invariants rather than leaving each integration to keep them.
 *
 * Section text is data read at boot and never a function, so two turns of one build render the same bytes: a
 * contribution cannot re-price the prompt prefix by rendering something new. And what an integration may contribute is
 * a closed list, because the surface here is what the code honours, not what the design will eventually hold.
 *
 * Not here yet, each refused by name until the code that honours it exists: `tools`, `hooks`, `commands`, `close()` and
 * `trust`. Refusing a key is the rule this change also makes the config entry follow, and for the same reason: a field
 * mason ignores is worse than a field it refuses, because the operator believes they configured something. Issue #85
 * found the same bug one layer down, where a `tools.headers` was silently dropped.
 */
import { INTEGRATION_NAME } from "../server/integrations.ts";

/** The integration API this build implements, which is what a contribution's `host` is compared against. */
export const HOST = 1;

/** One block of prompt text an integration adds, rendered under its own tag. */
export interface IntegrationSection {
	/** The tag it renders under and the key an audit reads. Lowercase, digits and underscores: it is a tag name. */
	readonly key: string;
	/** The text, fixed at boot. Never something a tool produced, and never something a remote server sent. */
	readonly text: string;
}

/** What an integration's own module returns. */
export interface IntegrationContribution {
	/** The integration's name: the same rule the config entry's key follows, because it is the same integration. */
	readonly name: string;
	/** The integration API this was written against. Newer than `HOST` refuses the boot, naming both numbers. */
	readonly host: number;
	/** Prompt sections this integration adds. Position, order, tag and cap stay the prompt's. */
	readonly sections?: readonly IntegrationSection[];
}

/** What `install()` hands back: the contribution as validated, with its sections in declaration order. */
export interface InstalledIntegration {
	readonly name: string;
	readonly sections: readonly IntegrationSection[];
}

/** A section key renders as `<key>`, so it has to be a tag name. */
const SECTION_KEY = /^[a-z][a-z0-9_]*$/;

/** The keys a contribution may carry, and the keys one section may carry. Both lists are the whole surface. */
const CONTRIBUTION_KEYS = ["host", "name", "sections"];
const SECTION_KEYS = ["key", "text"];

/**
 * Keys the design names and this build does not have. Listed so the refusal can say which: an operator who wrote
 * `tools` against the ADR is told the surface is not here yet, rather than that they invented a key.
 */
const NOT_YET = new Set(["close", "commands", "hooks", "tools", "trust"]);

/**
 * What an integration's module returns. Identity at runtime: what it buys is the array's type, so a module cannot
 * return something `install()` will only refuse at boot.
 */
export function defineIntegration(contribution: IntegrationContribution): IntegrationContribution {
	return contribution;
}

/**
 * The integrations this build ships, one line each. Empty until the chat's own knowledge moves in, and that is the
 * point of the list: what is not written here does not exist, so nothing arrives by being in the right directory.
 */
export const INTEGRATIONS: readonly IntegrationContribution[] = [];

/**
 * Validate every contribution once, at boot, and hand back what will be rendered.
 *
 * `reservedKeys` is the prompt's own sections: a contributed key that collides with one of them would render a second
 * block under a tag the prompt already owns, so the collision refuses the boot instead. The caller passes them rather
 * than this module knowing them, because the prompt is the only thing that decides what its own sections are called.
 *
 * Two integrations may not share a name or a section key. Section key collisions are checked across all of them, not
 * per integration, for the same reason: two blocks under one tag are one block the model cannot attribute.
 */
export function install(
	contributions: readonly IntegrationContribution[],
	options: { readonly reservedKeys: readonly string[] },
): readonly InstalledIntegration[] {
	const installed: InstalledIntegration[] = [];
	const names = new Set<string>();
	const keys = new Set(options.reservedKeys);
	for (const contribution of contributions) {
		if (typeof contribution !== "object" || contribution === null || Array.isArray(contribution)) {
			throw new Error("an integration contribution is not an object: `defineIntegration()` takes one literal");
		}
		const raw = contribution as unknown as Record<string, unknown>;
		const name = raw.name;
		if (typeof name !== "string" || !INTEGRATION_NAME.test(name)) {
			throw new Error(
				`integration contribution ${typeof name === "string" ? `"${name}"` : "(unnamed)"} is not a usable name: ` +
					"lowercase letters, digits and dashes, starting with a letter or a digit. It is the entry's key in the " +
					"prompt and the name a tool is built from (`mcp__<name>__<tool>`), so an underscore cannot appear.",
			);
		}
		if (names.has(name))
			throw new Error(`integration "${name}" is listed twice in INTEGRATIONS: one line per integration`);
		names.add(name);
		assertClosed(name, raw, CONTRIBUTION_KEYS);
		const host = raw.host;
		if (typeof host !== "number" || !Number.isInteger(host) || host < 1) {
			throw new Error(
				`integration "${name}" declares no usable "host": it is the integer integration API it was written ` +
					`against, and this build is ${HOST}`,
			);
		}
		if (host > HOST) {
			throw new Error(
				`integration "${name}" was written against integration API ${host}; this build is ${HOST}. A contribution ` +
					"newer than the build is refused rather than half-read, because the fields it needs are the fields " +
					"nothing here renders.",
			);
		}
		installed.push({ name, sections: readSections(name, raw.sections, keys) });
	}
	return installed;
}

/** One contribution's sections, each validated against the reserved keys and against every section already installed. */
function readSections(name: string, value: unknown, keys: Set<string>): readonly IntegrationSection[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`integration "${name}" has a "sections" that is not a list`);
	const sections: IntegrationSection[] = [];
	for (const [index, entry] of value.entries()) {
		const where = `integration "${name}" section ${index + 1}`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${where} is not an object with a "key" and a "text"`);
		}
		const raw = entry as unknown as Record<string, unknown>;
		const key = raw.key;
		if (typeof key !== "string" || !SECTION_KEY.test(key)) {
			throw new Error(
				`${where} has no usable key (${typeof key === "string" ? `"${key}"` : "none given"}): it renders as ` +
					"`<key>`, so it is lowercase letters, digits and underscores, starting with a letter",
			);
		}
		if (keys.has(key)) {
			throw new Error(
				`${where} renders under "<${key}>", which the prompt already has: a contributed key may not collide with ` +
					"a section the prompt owns or with another integration's, and two blocks under one tag are one block " +
					"the model cannot attribute",
			);
		}
		keys.add(key);
		assertClosed(name, raw, SECTION_KEYS, ` section "${key}"`);
		const text = raw.text;
		if (typeof text !== "string" || text.trim() === "") {
			throw new Error(`${where} (the block under "<${key}>") has no text: an empty section is not a section`);
		}
		sections.push({ key, text: text.trim() });
	}
	return sections;
}

/**
 * Refuse any key this build does not read. The refusal names the key rather than dropping it, because a dropped key is
 * a promise the file makes and the server silently breaks: `tools.headers` today, and every channel in
 * `docs/CONNECTOR-PROTOCOL.md` that the code has not built.
 */
function assertClosed(name: string, raw: Record<string, unknown>, known: readonly string[], where = ""): void {
	for (const key of Object.keys(raw)) {
		if (known.includes(key)) continue;
		const subject = where === "" ? `integration "${name}"` : `integration "${name}"${where}`;
		if (NOT_YET.has(key)) {
			throw new Error(
				`${subject} contributes "${key}", which is part of the contribution API and not in this build yet: it ` +
					"arrives with the code that honours it, and until then it is refused rather than ignored",
			);
		}
		throw new Error(
			`${subject} has the key "${key}", which this build does not read: the keys here are ${known.join(", ")}`,
		);
	}
}
