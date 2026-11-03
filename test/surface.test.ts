/**
 * The contribution surface: the generated catalog, and the one property that cannot be checked by reading it.
 *
 * `docs/SURFACE.md` exists so that a route and the grant that guards it are one row in one table, derived from the code
 * rather than typed by hand. What the table claims is a security property — every way into the server is authenticated,
 * or deliberately public with a sentence saying why — so it is asserted here as well as rendered there: the committed
 * file is what the renderer produces, every route literal in the two servers is granted or on the public list, and a
 * route with no guard stops the generator and names itself.
 *
 * The failure path is asserted against source strings, never by editing a server: a test that rewrote `main.ts` to prove
 * a check works would be a test that breaks the check it is proving.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	PUBLIC_ROUTES,
	readSources,
	renderSurface,
	routeLiterals,
	routeRows,
	SURFACE_PATH,
	SURFACE_SOURCES,
} from "../scripts/gen-surface.ts";

const root = new URL("../", import.meta.url).pathname;
const fixture = (text: string): { file: string; text: string }[] => [{ file: "fixture.ts", text }];

test("the committed docs/SURFACE.md is what the generator renders", () => {
	const committed = readFileSync(join(root, SURFACE_PATH), "utf8");
	// A one-line diff is the whole failure: either the file was edited by hand or a route, an extension or a budget moved
	// without `npm run gen:surface`. The generator itself says the same thing in CI, from the same function.
	assert.equal(committed, renderSurface());
});

test("every route literal in the two servers is granted, or on the public list with a reason", () => {
	const { rows, unguarded } = routeRows(readSources());
	assert.deepEqual(unguarded, [], "a route nothing guards: add requireGrant, or an entry in PUBLIC_ROUTES");
	assert.ok(rows.length > 0, "the route table is empty, which means the extractor stopped finding literals");
	for (const row of rows) {
		if (row.guard.startsWith("public")) {
			assert.notEqual(row.guard, "public", "a public route is labelled from the allowlist, never inferred");
			assert.match(row.guard, /^public — \S/);
			continue;
		}
		assert.notEqual(row.guard, "", `${row.route} is a row with no guard and no label`);
	}
	for (const file of SURFACE_SOURCES) {
		assert.ok(routeLiterals(readFileSync(join(root, file), "utf8")).length > 0, `${file} contributes no rows`);
	}
});

test("a route literal with no grant stops the generator, and names the route and its line", () => {
	const sources = fixture(`
async function handle(request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> {
	if (url.pathname === "/api/admin/secrets") {
		json(response, 200, { secret: true });
		return;
	}
}
`);
	const { rows, unguarded } = routeRows(sources);
	assert.deepEqual(rows, []);
	assert.deepEqual(unguarded, [{ route: "/api/admin/secrets", match: "exact", at: "fixture.ts:3" }]);
	assert.throws(() => renderSurface(sources), /a route with no guard: \/api\/admin\/secrets \(fixture\.ts:3\)/);
});

test("a grant in the block that answers a route is the one the row names", () => {
	const sources = fixture(`
async function handleAdmin(request, response, url, grants) {
	const [area] = segmentsOf(url.pathname);
	if (area === "tokens") {
		requireGrant(grants, "admin");
		json(response, 200, {});
		return;
	}
	if (url.pathname === "/api/permissions") {
		requireGrant(grants, "approve");
		json(response, 200, {});
	}
}
`);
	const { rows, unguarded } = routeRows(sources);
	assert.deepEqual(unguarded, []);
	assert.deepEqual(rows, [
		{
			route: "/api/permissions",
			match: "exact",
			guard: "`approve`",
			routeAt: "fixture.ts:9",
			guardAt: "fixture.ts:10",
		},
	]);
});

test("an inline hasGrant counts as the guard of a route that filters instead of refusing", () => {
	const sources = fixture(`
async function handle(url, device, response) {
	if (url.pathname === "/api/status") {
		if (device === undefined || !hasGrant(grantsOf(device), "conversation")) {
			return json(response, 403, {});
		}
		return json(response, 200, {});
	}
}
`);
	const { rows } = routeRows(sources);
	assert.equal(rows[0]?.guard, "`conversation`");
});

test("a dispatcher is followed to the handler it hands the route to, and the row says so", () => {
	const sources = fixture(`
async function handleOperatorRequest(request, response, url, deps, grants) {
	if (url.pathname === "/api/permissions" || url.pathname.startsWith("/api/permissions/")) {
		await handlePermissions(request, response, url, deps, grants);
		return;
	}
}

async function handlePermissions(request, response, url, deps, grants) {
	requireGrant(grants, "approve");
}
`);
	const { rows, unguarded } = routeRows(sources);
	assert.deepEqual(unguarded, []);
	assert.deepEqual(
		rows.map((row) => [row.route, row.match, row.guard, row.guardAt]),
		[
			["/api/permissions", "exact", "`approve` (delegated to `handlePermissions`)", "fixture.ts:10"],
			["/api/permissions/", "prefix", "`approve` (delegated to `handlePermissions`)", "fixture.ts:10"],
		],
	);
});

test("a public route is public only because the allowlist says so, and the route's own text is not the label", () => {
	const sources = fixture(`
function handle(pathname) {
	if (pathname === "/api/health") return true;
	return false;
}
`);
	const labelled = routeRows(sources);
	assert.deepEqual(labelled.unguarded, []);
	assert.match(labelled.rows[0]?.guard ?? "", /^public — /);

	const unlisted = routeRows(
		sources,
		PUBLIC_ROUTES.filter((entry) => entry.route !== "/api/health"),
	);
	assert.deepEqual(
		unlisted.unguarded.map((route) => route.route),
		["/api/health"],
	);
});

test("the allowlist names a reason for each door, and no door without one", () => {
	for (const entry of PUBLIC_ROUTES) {
		assert.ok(entry.route.startsWith("/"), `${entry.route} is not a path`);
		assert.ok(entry.why.length > 20, `${entry.route} needs a sentence a reviewer can argue with`);
	}
	const routes = PUBLIC_ROUTES.map((entry) => entry.route);
	assert.deepEqual([...new Set(routes)], routes, "the allowlist has a duplicate");
	// The probe and the connector's two paths are the ones a person cannot present a token for.
	for (const route of ["/api/health", "/api/connector", "/api/connector/attachments"]) {
		assert.ok(routes.includes(route), `${route} must stay on the list, with its reason`);
	}
});

test("no door is claimed as public that no comparison in a server answers", () => {
	const literals = readSources().flatMap((source) => routeLiterals(source.text).map((literal) => literal.route));
	const orphans = PUBLIC_ROUTES.map((entry) => entry.route).filter((route) => !literals.includes(route));
	// The connector's socket and its attachment endpoints are compared against `CONNECTOR_PATH`, so they are the two
	// doors absent from the literals on purpose. A third one is an allowlist entry that no longer matches anything.
	assert.deepEqual(orphans, ["/api/connector", "/api/connector/attachments"]);
});

test("a route matched above the gate is not guarded by the gate below it", () => {
	// The shape the check exists for: a route answered before the `authenticate` call, in the same function. Pairing it
	// with the guard the code reaches later would report the one route that never passes the door as authenticated.
	const sources = fixture(`
async function handle(request, response, url, store) {
	if (url.pathname === "/api/oops") {
		response.writeHead(200);
		return;
	}
	let device;
	if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") {
		const auth = await authenticate(request, store);
		if (!auth.ok) {
			response.writeHead(401);
			return;
		}
	}
}
`);
	const { rows, unguarded } = routeRows(sources);
	assert.deepEqual(unguarded, [{ route: "/api/oops", match: "exact", at: "fixture.ts:3" }]);
	assert.deepEqual(
		rows.map((row) => row.route),
		["/api/"],
		"the gate itself is guarded; the route above it is not",
	);
	assert.throws(() => renderSurface(sources), /a route with no guard: \/api\/oops/);
});

test("a route guarded by the block it opens is guarded", () => {
	const sources = fixture(`
async function handle(request, response, url, store) {
	if (url.pathname.startsWith("/api/")) {
		const auth = await authenticate(request, store);
		if (!auth.ok) return;
	}
	if (url.pathname === "/api/session") {
		return json(response, 200, {});
	}
}
`);
	const { rows, unguarded } = routeRows(sources);
	assert.deepEqual(unguarded, []);
	assert.deepEqual(
		rows.map((row) => [row.route, row.guard]),
		[
			["/api/", "`authenticate`"],
			["/api/session", "`authenticate`"],
		],
	);
});

test("a `!==` comparison excludes a path and is not a route", () => {
	const sources = fixture(`
function gate(pathname) {
	return pathname.startsWith("/api/") && pathname !== "/api/health";
}
`);
	assert.deepEqual(
		routeLiterals(sources[0]?.text ?? "").map((literal) => literal.route),
		["/api/"],
	);
});

test("a guard that exists only in a comment is not a guard", () => {
	// The shape a real diff takes: the call is deleted, the sentence that names it stays. Reading the raw source would
	// report the door as gated by a line that no longer runs.
	const sources = fixture(`
async function handle(request, response, url, store) {
	if (url.pathname === "/api/debug") {
		// const auth = await authenticate(request, store);
		return json(response, 200, {});
	}
}
`);
	const { rows, unguarded } = routeRows(sources);
	assert.deepEqual(unguarded, [{ route: "/api/debug", match: "exact", at: "fixture.ts:3" }]);
	assert.deepEqual(rows, []);
});

test("a guard in a preceding block that this path never enters does not gate a later route", () => {
	// A sibling branch's `requireGrant` is that branch's, not the function's: attributing it to a route below would make
	// the check dead in the one file that needs it.
	const sources = fixture(`
async function handleAdmin(url, response, grants) {
	if (url.pathname.startsWith("/api/admin/connectors")) {
		requireGrant(grants, "admin");
		return json(response, 200, {});
	}
	if (url.pathname === "/api/admin/debug") {
		return json(response, 200, {});
	}
}
`);
	const { unguarded } = routeRows(sources);
	assert.deepEqual(unguarded, [{ route: "/api/admin/debug", match: "exact", at: "fixture.ts:7" }]);
});

test("a gate that closed before the route still guards it, when its condition admits the path", () => {
	// The `/api/` gate in `main.ts`: one `if`, closed, and every route under it served afterwards. The condition is what
	// ties the two together, so a route the condition excludes is not covered by it.
	const sources = fixture(`
async function handle(request, response, url, store) {
	if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") {
		const auth = await authenticate(request, store);
		if (!auth.ok) return;
	}
	if (url.pathname === "/api/session") {
		return json(response, 200, {});
	}
	if (url.pathname === "/elsewhere") {
		return json(response, 200, {});
	}
}
`);
	const { rows, unguarded } = routeRows(sources);
	assert.deepEqual(unguarded, [{ route: "/elsewhere", match: "exact", at: "fixture.ts:10" }]);
	assert.deepEqual(
		rows.map((row) => [row.route, row.guard]),
		[
			["/api/", "`authenticate`"],
			["/api/session", "`authenticate`"],
		],
	);
});

test("a handler that filters by grant is not reported as refusing that grant for every path", () => {
	const sources = fixture(`
async function handleOperatorRequest(request, response, url, grants) {
	if (url.pathname.startsWith("/api/admin/")) {
		await handleAdmin(request, response, url, grants);
		return;
	}
}

async function handleAdmin(request, response, url, grants) {
	if (area === "connectors") {
		requireGrant(grants, "admin");
	}
	json(response, 200, await panelState(deps, grants));
}
`);
	const { rows } = routeRows(sources);
	assert.equal(rows[0]?.guard, "`admin`, filtered per area (delegated to `handleAdmin`)");
});

test("a path test nested under a non-path condition gates only that branch", () => {
	// `if (method === "POST") { if (pathname.startsWith("/api/")) { requireGrant() } }` is a gate on POSTs. Crediting it
	// to the routes below is round 2's sibling finding one level deeper, and the file it hides in is the panel's own.
	const sources = fixture(`
async function handle(request, url, response, grants) {
	if (request.method === "POST") {
		if (url.pathname.startsWith("/api/")) {
			requireGrant(grants, "admin");
		}
	}
	if (url.pathname === "/api/whatever") {
		return json(response, 200, {});
	}
}
`);
	const { unguarded } = routeRows(sources);
	assert.deepEqual(unguarded, [{ route: "/api/whatever", match: "exact", at: "fixture.ts:8" }]);
});

test("a regex literal holding a quote does not unblank the comments after it", () => {
	// The comment scan has to know what a regex is: `/['"]/` used to open a string that ran to the next quote in the file,
	// and every comment between was read as code — including a `requireGrant` that had been deleted.
	const sources = fixture(`
const NAME = /'/;
const other = raw.split(/["']/);
async function handle(url, response) {
	// requireGrant(grants, "admin");
	if (url.pathname === "/api/secret") {
		return json(response, 200, {});
	}
}
`);
	const { unguarded } = routeRows(sources);
	assert.deepEqual(unguarded, [{ route: "/api/secret", match: "exact", at: "fixture.ts:6" }]);
});
