/**
 * `src/tui/journeys.ts` — the table that says where an answer comes from, held to what it promises.
 *
 * A journey is only worth drawing if it is true: an address that stopped existing sends a person to a 404 at the one
 * moment they have no idea what the rest of the screen means. So the table is held to the two things a build can check
 * without a network — every secret a catalog entry asks for has a row, and every row is `https` — and to nothing else,
 * because whether a page still exists is not a fact this repository can read. 0.1.0 ships an empty catalog (#151), so the
 * secret half is checked against the fixture entry a later release adds back.
 *
 * The provider half is enumerated through pi-ai's own list rather than a list written here: a row whose id this build does
 * not ship is a page nobody can reach, and enumerating it is also what keeps this test honest when a provider is added.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { parseCatalog } from "../src/server/catalog.ts";
import { openProviders, providerIds } from "../src/server/provider.ts";
import { knownVariables, providerJourney, variableJourney } from "../src/tui/journeys.ts";
import { TELEGRAM_CATALOG } from "./support/catalog.ts";

describe("the journey table", () => {
	test("every secret a catalog connector asks for has the page that issues it", async () => {
		// 0.1.0 ships no catalog entry, so there is no shipped secret to hold to the table (#151). The fixture is the
		// entry the catalog gains back when its image ships; holding it to the table is what keeps that release from
		// asking for a token with no page to mint it.
		const { connectors } = parseCatalog(JSON.parse(await readFile(TELEGRAM_CATALOG, "utf8")));
		const secrets = connectors.flatMap((entry) =>
			entry.env
				.filter((variable) => variable.secret === true)
				.map((variable) => ({ connector: entry.name, name: variable.name })),
		);
		assert.ok(secrets.length > 0, "the fixture asks for no secret: this test would pass while proving nothing");
		for (const secret of secrets) {
			const journey = variableJourney(secret.name);
			assert.notEqual(
				journey,
				undefined,
				`"${secret.connector}" asks for ${secret.name} and no row in src/tui/journeys.ts says where it comes from`,
			);
			assert.match(journey?.url ?? "", /^https:\/\//, `${secret.name} points at something that is not https`);
		}
	});

	test("every address the table hands a screen is https", async () => {
		const urls: string[] = [];
		for (const name of knownVariables()) {
			const journey = variableJourney(name);
			assert.notEqual(journey, undefined, `${name} is a known variable with no row`);
			urls.push(journey?.url ?? "");
		}
		const access = await openProviders();
		for (const id of providerIds(access)) {
			const journey = providerJourney(id);
			if (journey !== undefined) urls.push(journey.url);
		}
		assert.ok(urls.length > 0, "no row was read: this test would pass while proving nothing");
		for (const url of urls) assert.match(url, /^https:\/\//, `${url} is not https`);
	});
});
