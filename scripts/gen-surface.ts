/**
 * `npm run gen:surface` — renders `docs/SURFACE.md` from the code it describes, and `--check` says whether the committed
 * copy still matches.
 *
 * The document this writes is a catalog nobody has to maintain by hand: the routes `src/server/` answers, the extensions
 * a boot installs, and the numbers in `src/server/limits.ts`. A hand-kept list of routes is a list that is right until
 * the next route, and an agent reading it has no way to tell the difference — so the list is derived, and CI runs the
 * check beside the typecheck.
 *
 * The part that matters is Table A. Every route literal in the two servers is paired with the `requireGrant` that guards
 * it, by position in the file: for a route checked inside an `if (url.pathname === …) { … }`, that block; failing that
 * the function around it; failing that the handler the block delegates to (`handlePermissions`, `handleAdmin`). A route
 * literal with none of those and no entry in `PUBLIC_ROUTES` is a route nothing gates, which is what a new route looks
 * like when someone forgets the guard: the generator refuses to write the file and names the route, so the diff says so
 * before a reviewer has to.
 *
 * Out of scope here, and next: the connector's method vocabulary (`packages/protocol`) and the projection's row kinds
 * (`src/server/projection.ts` + `src/shared/contract.ts`). Both belong in this file's output for the same reason.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import * as limits from "../src/server/limits.ts";
import { MCP_TOOL } from "../src/server/mcp.ts";
import { BASE_EXTENSIONS } from "../src/server/runtime.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

/** The one document this script writes, relative to the repository root. */
export const SURFACE_PATH = "docs/SURFACE.md";

/** The files whose route literals Table A lists, in the order the door is reached: HTTP first, then the panel's API. */
export const SURFACE_SOURCES: readonly string[] = ["src/server/main.ts", "src/server/admin.ts"];

/**
 * The doors deliberately outside the owner's gate.
 *
 * Table A labels a route `public` only from this list, and the reason is written here rather than in the table, so the
 * claim a route makes about itself is in the script a reviewer reads the diff of. Two entries name a constant rather
 * than a literal (`CONNECTOR_PATH`, `main.ts`) and so never appear as a row; they are here because the list is also the
 * answer to "which paths answer without a token", and a reader should get that in one place.
 */
export const PUBLIC_ROUTES: readonly { readonly route: string; readonly why: string }[] = [
	{
		route: "/api/health",
		why: "the liveness probe: `ok` and the boot's root id, so an unpaired browser can tell a dead server from a wrong token",
	},
	{
		route: "/api/connector",
		why: "the connector's socket, authenticated as the connector by its own credential (`main.ts`, `CONNECTOR_PATH`)",
	},
	{
		route: "/api/connector/attachments",
		why: "the connector's attachment bytes, the same credential on every request (`main.ts`, `CONNECTOR_PATH`)",
	},
	{
		route: "/",
		why: "the panel's static shell: a bundle with no secrets in it, and where an unpaired browser is told so",
	},
	{ route: "/index.html", why: "the same shell, by its file name" },
	{ route: "/admin", why: "the same shell: `/admin` is a door into one page, not a second one" },
	{ route: "/admin/", why: "the same shell, with the trailing slash" },
];

export interface Source {
	/** A path relative to the repository root, as a reviewer would type it. */
	readonly file: string;
	readonly text: string;
}

/** One route literal and the guard that applies to it. */
export interface RouteRow {
	readonly route: string;
	readonly match: "exact" | "prefix";
	/** `` `admin` ``, `` `admin` + `authenticate` ``, `authenticate`, or `public — <why>`. */
	readonly guard: string;
	/** `<file>:<line>` of the literal. */
	readonly routeAt: string;
	/** `<file>:<line>` of the guard, or `not gated` for a public route. */
	readonly guardAt: string;
}

/** A route literal the pairing could not guard. Its presence is what makes the generator exit non-zero. */
export interface UnguardedRoute {
	readonly route: string;
	readonly match: "exact" | "prefix";
	readonly at: string;
}

interface Literal {
	readonly route: string;
	readonly match: "exact" | "prefix";
	readonly index: number;
	readonly line: number;
}

interface Guard {
	readonly kind: "grant" | "authenticated" | "connector";
	readonly name?: string;
	readonly index: number;
	readonly line: number;
}

interface Range {
	readonly start: number;
	readonly end: number;
}

/**
 * The source with comments and string bodies blanked out, one character for one character.
 *
 * Line numbers survive, so a position found here is a position in the file; what is gone is the punctuation inside a
 * comment or a string, which is the punctuation that would otherwise balance a brace that is not there.
 */
export function maskSource(text: string): string {
	const out = [...text];
	const blank = (from: number, to: number): void => {
		for (let at = from; at < to && at < out.length; at++) {
			if (out[at] !== "\n") out[at] = " ";
		}
	};
	let at = 0;
	while (at < text.length) {
		const char = text[at];
		if (char === "/" && text[at + 1] === "/") {
			const end = text.indexOf("\n", at);
			const stop = end === -1 ? text.length : end;
			blank(at, stop);
			at = stop;
			continue;
		}
		if (char === "/" && text[at + 1] === "*") {
			const end = text.indexOf("*/", at + 2);
			const stop = end === -1 ? text.length : end + 2;
			blank(at, stop);
			at = stop;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			let cursor = at + 1;
			while (cursor < text.length) {
				if (text[cursor] === "\\") {
					cursor += 2;
					continue;
				}
				if (text[cursor] === char) break;
				// A quote that never closes on its own line is punctuation inside a regex, not a string: masking from it
				// would run past the end of the statement and swallow the brace that ends the function.
				if (char !== "`" && text[cursor] === "\n") {
					cursor = at;
					break;
				}
				cursor++;
			}
			if (cursor > at) {
				blank(at + 1, cursor);
				at = cursor + 1;
			} else {
				at++;
			}
			continue;
		}
		at++;
	}
	return out.join("");
}

/** Every brace range in the masked source, innermost first when sorted by start. Unbalanced closers are ignored. */
function braceRanges(masked: string): Range[] {
	const ranges: Range[] = [];
	const open: number[] = [];
	for (let at = 0; at < masked.length; at++) {
		if (masked[at] === "{") open.push(at);
		else if (masked[at] === "}") {
			const start = open.pop();
			if (start !== undefined) ranges.push({ start, end: at });
		}
	}
	return ranges;
}

/** The innermost range holding `index`, or `undefined` at module top level. */
function innermost(ranges: readonly Range[], index: number): Range | undefined {
	let found: Range | undefined;
	for (const range of ranges) {
		if (range.start >= index || range.end <= index) continue;
		if (found === undefined || range.start > found.start) found = range;
	}
	return found;
}

/**
 * The block a statement opens after `index`, when it opens one.
 *
 * A route literal sits in the condition of the `if` that answers it (`if (url.pathname === "…") {`), so the block that
 * holds the guard begins after the literal and its condition may run over several lines. A statement with no block — an
 * `if (…) return false;`, a `return pathname === "…"` — has none, and the caller falls back to what encloses it.
 */
function statementBlock(masked: string, ranges: readonly Range[], index: number): Range | undefined {
	let depth = 0;
	for (let at = index; at < masked.length && at < index + 4000; at++) {
		const char = masked[at];
		if (char === "(") depth++;
		else if (char === ")") depth = Math.max(0, depth - 1);
		else if (char === ";" && depth === 0) return undefined;
		else if (char === "}" && depth === 0) return undefined;
		else if (char === "{" && depth === 0) {
			return ranges.find((range) => range.start === at);
		}
	}
	return undefined;
}

const LITERAL_PATTERNS: readonly { readonly pattern: RegExp; readonly match: "exact" | "prefix" }[] = [
	// `!==` is not a route: it excludes one path from the branch below it, and listing it would name the liveness probe as
	// a door at the line that skips it. A negated `startsWith` is kept: a guard clause is how the panel routes a prefix.
	{ pattern: /\bpathname\s*(===|!==)\s*"([^"]*)"/g, match: "exact" },
	{ pattern: /\bpathname\.startsWith\(\s*"([^"]*)"/g, match: "prefix" },
];

/** Every plain-string route literal in one file. A path built from a constant (`${CONNECTOR_PATH}/…`) is not one. */
export function routeLiterals(text: string): Literal[] {
	const found: Literal[] = [];
	for (const { pattern, match } of LITERAL_PATTERNS) {
		pattern.lastIndex = 0;
		for (let hit = pattern.exec(text); hit !== null; hit = pattern.exec(text)) {
			if (match === "exact" && hit[1] === "!==") continue;
			const index = hit.index;
			found.push({
				route: (match === "exact" ? hit[2] : hit[1]) ?? "",
				match,
				index,
				line: text.slice(0, index).split("\n").length,
			});
		}
	}
	return found.sort((left, right) => left.index - right.index);
}

/**
 * The source with comments blanked and string literals kept.
 *
 * `maskSource` blanks both, which is what block ranges need, but a guard's argument *is* a string (`requireGrant(grants,
 * "admin")`), so the guard scan needs the other half: comments gone, so a line of prose that names a guard is not a
 * guard, and strings kept, so the grant it names survives.
 */
export function maskComments(text: string): string {
	const out = [...text];
	const blank = (from: number, to: number): void => {
		for (let at = from; at < to && at < out.length; at++) {
			if (out[at] !== "\n") out[at] = " ";
		}
	};
	/** Where a regex literal opened at `at` ends, or -1 when it does not end on this line. */
	const regexEnd = (at: number): number => {
		let inClass = false;
		for (let cursor = at + 1; cursor < text.length; cursor++) {
			const char = text[cursor];
			if (char === "\n") return -1;
			if (char === "\\") {
				cursor++;
				continue;
			}
			if (char === "[") inClass = true;
			else if (char === "]") inClass = false;
			else if (char === "/" && !inClass) return cursor + 1;
		}
		return -1;
	};
	/** Whether a `/` here opens a regex rather than dividing: it follows a token that cannot end an expression. */
	const opensRegex = (at: number): boolean => {
		let back = at - 1;
		while (back >= 0 && /\s/.test(text[back] ?? "")) back--;
		if (back < 0) return true;
		if ("(,=:[!&|?{};+-*%<>~^".includes(text[back] ?? "")) return true;
		const word = /(\w+)$/.exec(text.slice(Math.max(0, back - 8), back + 1))?.[1] ?? "";
		return ["return", "typeof", "case", "in", "of", "new", "delete", "void", "else", "do", "yield"].includes(word);
	};
	let at = 0;
	while (at < text.length) {
		const char = text[at];
		if (char === "/" && text[at + 1] === "/") {
			const end = text.indexOf("\n", at);
			const stop = end === -1 ? text.length : end;
			blank(at, stop);
			at = stop;
			continue;
		}
		if (char === "/" && text[at + 1] === "*") {
			const end = text.indexOf("*/", at + 2);
			const stop = end === -1 ? text.length : end + 2;
			blank(at, stop);
			at = stop;
			continue;
		}
		// A regex literal holds quotes (`/['"]/`), so it has to be skipped whole or its apostrophe opens a string that
		// runs to the next quote in the file — and everything between, comments included, is then read as code.
		if (char === "/" && opensRegex(at)) {
			const stop = regexEnd(at);
			if (stop !== -1) {
				at = stop;
				continue;
			}
		}
		// A string is skipped whole, so a `//` inside one (`"https://…"`) is not read as a comment. An unterminated `"` or
		// `'` cannot span a line, so a newline means it was not a string after all and the scan stays in code.
		if (char === '"' || char === "'" || char === "`") {
			let cursor = at + 1;
			while (cursor < text.length && text[cursor] !== char) {
				if (text[cursor] === "\\") cursor++;
				else if (text[cursor] === "\n" && char !== "`") break;
				cursor++;
			}
			at = text[cursor] === char ? cursor + 1 : at + 1;
			continue;
		}
		at++;
	}
	return out.join("");
}

const GUARD_PATTERNS: readonly { readonly pattern: RegExp; readonly kind: Guard["kind"] }[] = [
	{ pattern: /requireGrant\(\s*grants?\s*,\s*"(\w+)"/g, kind: "grant" },
	{ pattern: /hasGrant\(\s*grantsOf\(\s*\w+\s*\)\s*,\s*"(\w+)"/g, kind: "grant" },
	{ pattern: /\bauthenticateConnector\(/g, kind: "connector" },
	{ pattern: /\bauthenticate\(/g, kind: "authenticated" },
];

/**
 * Every guard call inside `range`, with the line it is on.
 *
 * `comments` is `maskComments(text)`: same length, same indices, comments blanked. A guard that exists only in a comment
 * — a deleted `requireGrant` whose sentence stayed behind — is not a guard, and this is the shape a real diff takes.
 */
function guardsIn(text: string, comments: string, range: Range): Guard[] {
	const slice = comments.slice(range.start, range.end);
	const lineOf = (index: number): number => text.slice(0, range.start + index).split("\n").length;
	const guards: Guard[] = [];
	for (const { pattern, kind } of GUARD_PATTERNS) {
		pattern.lastIndex = 0;
		for (let hit = pattern.exec(slice); hit !== null; hit = pattern.exec(slice)) {
			guards.push({
				kind,
				...(kind === "grant" ? { name: hit[1] ?? "" } : {}),
				index: range.start + hit.index,
				line: lineOf(hit.index),
			});
		}
	}
	return guards.sort((left, right) => left.index - right.index);
}

/** `function name(` declarations in a file: what a dispatcher block may hand a route to. */
function declaredFunctions(masked: string): Map<string, number> {
	const names = new Map<string, number>();
	const pattern = /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/g;
	for (let hit = pattern.exec(masked); hit !== null; hit = pattern.exec(masked)) {
		names.set(hit[1] ?? "", hit.index);
	}
	return names;
}

/**
 * The guards written directly in `region`: a call nested inside a conditional is not one of them.
 *
 * A `requireGrant` inside `if (connector !== undefined)` gates that branch, not the block it sits in, so attributing it
 * to a route in the sibling branch below would report a door nothing gates as gated. Only the calls whose innermost
 * block is `region` itself are the block's own gate.
 */
function directGuards(text: string, comments: string, ranges: readonly Range[], region: Range): Guard[] {
	return guardsIn(text, comments, region).filter((guard) => {
		const holder = innermost(ranges, guard.index);
		return holder !== undefined && holder.start === region.start;
	});
}

/**
 * Whether a block is entered for `route`, all the way down: every `if` that encloses it must be a path test that holds.
 *
 * A path test nested under a method test (`if (method === "POST") { if (pathname.startsWith("/api/")) { requireGrant() } }`)
 * is a gate on POSTs, not on the routes below it, so the chain is the fact that matters and not the nearest condition.
 */
function admits(comments: string, ranges: readonly Range[], outermost: Range, block: Range, route: string): boolean {
	let cursor: Range | undefined = block;
	while (cursor !== undefined && cursor.start > outermost.start) {
		if (admission(comments, cursor)?.(route) !== true) return false;
		cursor = innermost(ranges, cursor.start);
	}
	return true;
}

/**
 * Whether a handler hands `grants` to a function that is not one of the guard helpers.
 *
 * The panel's `handleAdmin` refuses `admin` for the areas it owns and passes the device's grants to `panelState`, which
 * filters the payload instead of refusing it: a row that named `admin` for the whole `/api/admin/` prefix would be false
 * for the two routes every screen calls (`test/panel.test.ts` pins the `conversation`-only device getting `200`). The
 * row says "filtered per area" instead, and this is the text that decides it.
 */
function handsGrantsOn(masked: string, body: Range): boolean {
	const helpers = new Set(["requireGrant", "hasGrant", "grantsOf", "requireMethod"]);
	const called = /(\w+)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
	const slice = masked.slice(body.start, body.end);
	for (let hit = called.exec(slice); hit !== null; hit = called.exec(slice)) {
		const name = hit[1] ?? "";
		if (helpers.has(name)) continue;
		if (/\bgrants\b/.test(hit[2] ?? "")) return true;
	}
	return false;
}

/**
 * The path test a block is entered under, when its `if` condition is nothing but path tests.
 *
 * `if (url.pathname.startsWith("/api/")) { authenticate() }` guards everything under `/api/` although the call is not an
 * ancestor of those routes: the block ends, and execution continues past it only when the condition held. So the guard
 * inside it applies to a route exactly when the condition admits that route — and `if (connector !== undefined) { … }`,
 * whose condition says nothing about the path, admits none, which is what keeps one branch's guard off its sibling.
 *
 * Returns `undefined` for a condition this cannot read (a flag, a `||`, a call), and the caller treats that as "admits
 * nothing": an unreadable condition must fail the route loudly rather than vouch for it.
 */
function admission(comments: string, block: Range): ((route: string) => boolean) | undefined {
	let at = block.start - 1;
	while (at >= 0 && /\s/.test(comments[at] ?? "")) at--;
	if (comments[at] !== ")") return undefined;
	let depth = 0;
	let open = -1;
	for (let cursor = at; cursor >= 0; cursor--) {
		if (comments[cursor] === ")") depth++;
		else if (comments[cursor] === "(") {
			depth--;
			if (depth === 0) {
				open = cursor;
				break;
			}
		}
	}
	if (open < 0) return undefined;
	const keyword = /(\bif)\s*$/.exec(comments.slice(Math.max(0, open - 12), open));
	if (keyword === null) return undefined;
	const condition = comments.slice(open + 1, at);
	const clauses = condition.split("&&").map((clause) => clause.trim());
	const tests: ((route: string) => boolean)[] = [];
	for (const clause of clauses) {
		const prefix = /^!?(?:url\.)?pathname\.startsWith\(\s*"([^"]*)"\s*\)$/.exec(clause);
		const equal = /^!?(?:url\.)?pathname\s*(===|!==)\s*"([^"]*)"$/.exec(clause);
		if (prefix !== null) {
			const path = prefix[1] ?? "";
			const negated = clause.startsWith("!");
			tests.push((route) => route.startsWith(path) !== negated);
			continue;
		}
		if (equal !== null) {
			const same = equal[1] === "===";
			const path = equal[2] ?? "";
			tests.push((route) => (route === path) === same);
			continue;
		}
		return undefined;
	}
	return (route) => tests.every((test) => test(route));
}

/**
 * The guard that applies to one literal: the nearest guard that precedes it inside its block, else the nearest that
 * precedes it in an enclosing block, else the guard the handler it delegates to opens with. `undefined` when nothing
 * gates it.
 *
 * Precedence matters more than proximity. A guard *below* a literal does not gate it: a route matched above the gate is
 * exactly the omission this table exists to catch, and an extractor that pairs it with the `authenticate` call further
 * down would report the one route that never reaches it as guarded.
 */
function guardFor(
	text: string,
	masked: string,
	comments: string,
	ranges: readonly Range[],
	functions: Map<string, number>,
	literal: Literal,
): { readonly guards: readonly Guard[]; readonly delegate?: string; readonly filtered?: boolean } | undefined {
	// The block the literal opens is the most specific gate there is: `if (pathname.startsWith("/api/")) { authenticate() }`
	// guards every route below it, and the call sits after the literal rather than before it.
	const own = statementBlock(masked, ranges, literal.index);
	if (own !== undefined) {
		const guards = directGuards(text, comments, ranges, own);
		if (guards.length > 0) return { guards: nearest(guards) };
	}
	let enclosing = innermost(ranges, literal.index);
	let outermost = enclosing;
	while (enclosing !== undefined) {
		const guards = nearest(
			directGuards(text, comments, ranges, enclosing).filter((guard) => guard.index < literal.index),
		);
		if (guards.length > 0) return { guards };
		outermost = enclosing;
		enclosing = innermost(ranges, enclosing.start);
	}
	// A block that ended before the literal can still gate it, when its condition is a path test this route passes: the
	// gate over `/api/` is one `if`, and every route under it is served after that block closed.
	if (outermost !== undefined) {
		const admitting = ranges
			.filter((range) => range.start > outermost.start && range.end < literal.index)
			.filter((range) => admits(comments, ranges, outermost, range, literal.route))
			.sort((left, right) => right.start - left.start);
		for (const range of admitting) {
			const guards = nearest(directGuards(text, comments, ranges, range));
			if (guards.length > 0) return { guards };
		}
	}
	// Nothing gates the literal directly: it may be a dispatcher handing the route to a handler in this file, which is
	// how the panel keeps one grant check per area rather than one per URL.
	const region = statementBlock(masked, ranges, literal.index) ?? innermost(ranges, literal.index);
	if (region === undefined) return undefined;
	const called = /(\w+)\s*\(/g;
	// From the literal forward, not from the block's start: a dispatcher's first delegation is the one this route takes,
	// and a call above the literal belongs to a route above it.
	const slice = masked.slice(literal.index, region.end);
	for (let hit = called.exec(slice); hit !== null; hit = called.exec(slice)) {
		const name = hit[1] ?? "";
		const declared = functions.get(name);
		if (declared === undefined) continue;
		const body = statementBlock(masked, ranges, declared);
		if (body === undefined) continue;
		// Every grant the handler enforces, not the first one it reaches: `handleAdmin` checks `admin` for the area it
		// owns and filters the two routes every panel screen calls by `conversation`, so a single grant in the row would be
		// a claim about the whole prefix that the handler does not make.
		const guards = nearest(guardsIn(text, comments, body));
		if (guards.length > 0) return { guards, delegate: name, filtered: handsGrantsOn(masked, body) };
	}
	return undefined;
}

/**
 * The guard set that applies to a literal: the nearest preceding guard of each kind.
 *
 * One preceding `requireGrant` and one preceding `authenticate` are two different facts (a gate and a grant), so they
 * are kept apart; two preceding `requireGrant`s for the same grant are one fact. Nothing that follows the literal is
 * considered: a guard the code reaches later is not a guard on this route.
 */
function nearest(guards: readonly Guard[]): Guard[] {
	const keep: Guard[] = [];
	for (const guard of guards) {
		const twin = keep.find((kept) => kept.kind === guard.kind && kept.name === guard.name);
		if (twin === undefined) keep.push(guard);
	}
	return keep;
}

function renderGuard(guards: readonly Guard[], delegate: string | undefined, filtered = false): string {
	const parts: string[] = [];
	for (const guard of guards) {
		if (guard.kind === "grant") parts.push(`\`${guard.name}\``);
		else if (guard.kind === "connector") parts.push("connector credential");
		else parts.push("`authenticate`");
	}
	const joined = parts.join(" + ");
	if (delegate === undefined) return joined;
	const how = filtered ? `${joined}, filtered per area` : joined;
	return `${how} (delegated to \`${delegate}\`)`;
}

/**
 * Table A, as rows: one per route literal in `sources`, and the literals nothing guards.
 *
 * Pure on purpose, and exported for the test: the failure path is the reason the table exists, so it is asserted against
 * a fixture rather than by editing a server.
 */
export function routeRows(
	sources: readonly Source[],
	allowlist: readonly { readonly route: string; readonly why: string }[] = PUBLIC_ROUTES,
): { readonly rows: RouteRow[]; readonly unguarded: UnguardedRoute[] } {
	const rows: RouteRow[] = [];
	const unguarded: UnguardedRoute[] = [];
	// One row per (path, match, guard): the same shell is matched in three places and the same probe twice, and a table
	// that repeats them reads as three doors where there is one. The first occurrence keeps its line.
	const key = (row: RouteRow): string =>
		`${row.route}|${row.match}|${row.guard.replace(/ \(delegated to [^)]*\)$/, "")}`;
	const push = (row: RouteRow): void => {
		if (rows.some((kept) => key(kept) === key(row))) return;
		rows.push(row);
	};
	for (const source of sources) {
		const masked = maskSource(source.text);
		const comments = maskComments(source.text);
		const ranges = braceRanges(masked);
		const functions = declaredFunctions(masked);
		for (const literal of routeLiterals(source.text)) {
			const where = `${source.file}:${literal.line}`;
			const allowed = allowlist.find((entry) => entry.route === literal.route);
			if (allowed !== undefined) {
				push({
					route: literal.route,
					match: literal.match,
					guard: `public — ${allowed.why}`,
					routeAt: where,
					guardAt: "not gated",
				});
				continue;
			}
			const found = guardFor(source.text, masked, comments, ranges, functions, literal);
			if (found === undefined) {
				unguarded.push({ route: literal.route, match: literal.match, at: where });
				continue;
			}
			push({
				route: literal.route,
				match: literal.match,
				guard: renderGuard(found.guards, found.delegate, found.filtered),
				routeAt: where,
				guardAt: `${source.file}:${found.guards[0]?.line ?? literal.line}`,
			});
		}
	}
	return { rows, unguarded };
}

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
	const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
	for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
	return lines.join("\n");
}

function codeList(names: readonly string[]): string {
	return names.length === 0 ? "--" : names.map((name) => `\`${name}\``).join(", ");
}

/** Table B: the extensions `BASE_EXTENSIONS` installs, read off the objects rather than out of the source. */
export function extensionRows(): (readonly string[])[] {
	return BASE_EXTENSIONS.map((extension) => [
		`\`${extension.name}\``,
		codeList((extension.tools ?? []).map((tool) => tool.name)),
		codeList((extension.sections ?? []).map((section) => section.key)),
		codeList([
			...(extension.hooks ?? []).map((hook) => hook.task),
			...(extension.tasks ?? []).map((task) => task.definition.name),
		]),
	]);
}

/** Table B, second half: the extensions a boot builds for itself. */
export function perBootRows(): (readonly string[])[] {
	return [
		["`mcp`", codeList(Object.values(MCP_TOOL)), "an integration has a tools face"],
		["`codemode`", codeList([CODEMODE_TOOL_NAME]), "always"],
		["`permissions`", "--", "always"],
	];
}

/**
 * The one-line meaning of a constant: the first sentence of the nearest doc comment above it.
 *
 * The nearest, not the immediately preceding one: `limits.ts` documents its three connector budgets with one comment,
 * and a meaning of "none" for the second and third would be worse than the group's own sentence.
 */
function meaningOf(text: string, index: number): string {
	const before = text.slice(0, index);
	const open = before.lastIndexOf("/**");
	if (open === -1) return "--";
	const close = before.indexOf("*/", open);
	if (close === -1) return "--";
	const body = before
		.slice(open + 3, close)
		.split("\n")
		.map((line) => line.replace(/^\s*\*?\s?/, "").trim())
		.filter((line) => line !== "")
		.join(" ");
	const sentence = /^(.*?[.!?])(\s|$)/.exec(body);
	return (sentence?.[1] ?? body).trim();
}

function formatValue(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
	}
	return String(value);
}

/** Table C: every exported constant of `limits.ts`, its value, and what its own comment says it is for. */
export function limitRows(): (readonly string[])[] {
	const source = readFileSync(join(root, "src/server/limits.ts"), "utf8");
	const exports = (limits as unknown as Record<string, unknown>) ?? {};
	const rows: (readonly string[])[] = [];
	const pattern = /^export const (\w+)\s*=/gm;
	for (let hit = pattern.exec(source); hit !== null; hit = pattern.exec(source)) {
		const name = hit[1] ?? "";
		const value = exports[name];
		if (typeof value !== "number") continue;
		rows.push([`\`${name}\``, `\`${formatValue(value)}\``, meaningOf(source, hit.index)]);
	}
	return rows;
}

/** Reads the two servers this document's Table A is about. */
export function readSources(): Source[] {
	return SURFACE_SOURCES.map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

/** Hard-wraps a paragraph the way the hand-written documents are wrapped: ~115 columns, no matter how it is typed. */
function wrap(text: string, width = 115): string {
	const lines: string[] = [];
	const words: string[] = [];
	// A `code span` is one word however it was typed: a break inside it renders as a space, which reads as a typo.
	let open = false;
	for (const piece of text.split(/\s+/).filter((piece) => piece !== "")) {
		const ticks = (piece.match(/`/g) ?? []).length;
		if (open) words[words.length - 1] = `${words[words.length - 1] ?? ""} ${piece}`;
		else words.push(piece);
		if (ticks % 2 === 1) open = !open;
	}
	let line = "";
	for (const word of words) {
		if (line === "") line = word;
		else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line !== "") lines.push(line);
	return lines.join("\n");
}

/** The whole document, from the code as it is now. */
export function renderSurface(sources: readonly Source[] = readSources()): string {
	const { rows, unguarded } = routeRows(sources);
	if (unguarded.length > 0) {
		const named = unguarded.map((route) => `${route.route} (${route.at})`).join(", ");
		throw new Error(
			`a route with no guard: ${named}. Call \`requireGrant\` in the block that answers it, or add it to \`PUBLIC_ROUTES\` in scripts/gen-surface.ts with the reason it answers without a credential.`,
		);
	}
	const parts: string[] = [];
	parts.push("<!-- generated by scripts/gen-surface.ts: do not edit this file; run `npm run gen:surface` -->");
	parts.push("");
	parts.push("# The surface");
	parts.push("");
	parts.push(
		wrap(
			"What the code offers, read out of the code: the routes and the grants that guard them, the extensions a boot installs, and the numbers a caller may spend against. Every table here is rendered, so a route or a grant that is wrong is a `npm run gen:surface:check` failure in the pull request that made it wrong, rather than a stale list someone trusts later. Where a behaviour goes, as opposed to what exists, is [`ARCHITECTURE.md`](ARCHITECTURE.md).",
		),
	);
	parts.push("");
	parts.push("## A. HTTP routes, and the grant that guards each");
	parts.push("");
	parts.push(
		wrap(
			'One row per plain-string route literal in `src/server/main.ts` and `src/server/admin.ts` — every `url.pathname === "…"` and `url.pathname.startsWith("…")`. A path built from a constant is not a literal and so is not a row: the connector\'s socket and its attachment endpoints are `CONNECTOR_PATH` in `main.ts`, and they are listed below, with the other doors that answer without the owner\'s token.',
		),
	);
	parts.push("");
	parts.push(
		wrap(
			"`exact` is `===`, `prefix` is `startsWith`; a `!==` is not a route and is not a row. The guard is the `requireGrant`, or the inline `hasGrant` for a route that filters rather than refuses, found in the block the literal opens, or in a block above it that this path enters — the `/api/` gate is one `if` that closes, and every route under it is served after the block ended — or, failing that, in the handler it delegates to. When the block is a dispatcher, the row names the handler it hands the route to and `delegated to` says which; `filtered per area` means that handler refuses the grant for the areas it owns and hands the device's grants to a function that filters the payload instead (the panel's `state` and `control` answer a device holding `conversation`, which `test/panel.test.ts` pins). A literal with no guard stops the generator, which is the point: a route added without a `requireGrant` is unauthenticated by omission. A path matched in several places is one row, the first, when the guard is the same — which is sometimes a predicate (`isShellPath`) rather than the handler that serves it. A path behind two doors keeps two rows: `/api/admin/` passes the server's `authenticate` and then the panel's own grant, and both are true.",
		),
	);
	parts.push("");
	parts.push(table(["Route", "Match", "Guard", "Route at", "Guarded at"], rows.map(toRow)));
	parts.push("");
	parts.push("## Doors that answer without the owner's token");
	parts.push("");
	parts.push(
		wrap(
			"Each of these is in the generator's `PUBLIC_ROUTES` with its reason, and nothing may be added there without a sentence a reviewer can argue with. The list is also the whole answer to \"which paths answer without a token\", which is why the connector's two paths are here although they are constant-built and never a row.",
		),
	);
	parts.push("");
	parts.push(
		table(
			["Route", "Why it is public"],
			PUBLIC_ROUTES.map((entry) => [`\`${entry.route}\``, entry.why]),
		),
	);
	parts.push("");
	parts.push("## B. Extensions a boot installs");
	parts.push("");
	parts.push(
		wrap(
			"`BASE_EXTENSIONS` in `src/server/runtime.ts`, with every name read off the objects rather than out of the source.",
		),
	);
	parts.push("");
	parts.push(table(["Extension", "Tools", "Prompt sections", "Hook tasks"], extensionRows()));
	parts.push("");
	parts.push(
		wrap(
			"Built per boot rather than declared in the array, so they are listed from their own definitions: the MCP tools are `MCP_TOOL` in `src/server/mcp.ts` and are the only way a service's tools are reached; the code-mode tool is the one a script writes; `permissions` contributes no tool at all, only the `beforeTool` gate.",
		),
	);
	parts.push("");
	parts.push(table(["Extension", "Tools", "Installed when"], perBootRows()));
	parts.push("");
	parts.push("## C. What a caller may spend");
	parts.push("");
	parts.push(
		wrap(
			"Every exported number in `src/server/limits.ts`: the value is the constant's own, and the meaning is the first sentence of its comment. The three connector budgets share one comment, so they share one meaning and are counted separately; the budgets are per class on purpose (`docs/SPEC.md` §4.1c), so a flood in one cannot starve another.",
		),
	);
	parts.push("");
	parts.push(table(["Constant", "Value", "Meaning"], limitRows()));
	parts.push("");
	return parts.join("\n");
}

function toRow(row: RouteRow): readonly string[] {
	return [
		`\`${row.route}\``,
		row.match,
		row.guard,
		`\`${row.routeAt}\``,
		row.guardAt === "not gated" ? "not gated" : `\`${row.guardAt}\``,
	];
}

/** Where the first two renderings disagree, for a `--check` that has to say something useful. */
function firstDifference(committed: string, rendered: string): string {
	const left = committed.split("\n");
	const right = rendered.split("\n");
	const length = Math.max(left.length, right.length);
	for (let at = 0; at < length; at++) {
		if ((left[at] ?? "") === (right[at] ?? "")) continue;
		return `line ${at + 1}:\n  committed: ${left[at] ?? "(end of file)"}\n  rendered:  ${right[at] ?? "(end of file)"}`;
	}
	return "the files differ but no line does";
}

function main(): never {
	const check = process.argv.slice(2).includes("--check");
	const rendered = renderSurface();
	const bytes = Buffer.byteLength(rendered, "utf8");
	const read = (): string | undefined => {
		try {
			return readFileSync(join(root, SURFACE_PATH), "utf8");
		} catch {
			return undefined;
		}
	};
	if (check) {
		const committed = read();
		if (committed === rendered) {
			console.log(`[gen-surface] ${SURFACE_PATH} is up to date (1 file, ${bytes} bytes)`);
			process.exit(0);
		}
		console.error(`[gen-surface] ${SURFACE_PATH} is stale: 1 file, ${bytes} bytes rendered`);
		console.error(
			committed === undefined
				? "  the file is missing; run `npm run gen:surface`"
				: `  ${firstDifference(committed, rendered)}`,
		);
		console.error("  run `npm run gen:surface` and commit the result.");
		process.exit(1);
	}
	writeFileSync(join(root, SURFACE_PATH), rendered);
	console.log(`[gen-surface] wrote ${SURFACE_PATH} (1 file, ${bytes} bytes)`);
	process.exit(0);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
