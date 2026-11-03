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
