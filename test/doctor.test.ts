/**
 * The single-user cutover (`cutover.ts`), as `npm run doctor -- migrate` runs it.
 *
 * Three pieces of configuration a room needed are no longer read: an actor map on a connector's user face, the
 * `unattributed` posture, a named `approver`, and `service/roster.json`. The migration is what moves a home forward, so
 * what is pinned here is the shape of the move rather than the boot: one mapped actor becomes the one `owner`, several
 * are a refusal that names them, and the roster is printed before it is deleted rather than left as a file whose owner
 * believes it still decides who may speak.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cutOverSingleUser } from "../src/server/cutover.ts";
import { housePaths } from "../src/server/house.ts";
import { readIntegrations } from "../src/server/integrations.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** A home laid out as the split has it, with the integrations file a person wrote. */
async function home(integrations: unknown, roster?: unknown): Promise<ReturnType<typeof housePaths>> {
	const directory = await mkdtemp(join(tmpdir(), "mason-cutover-"));
	directories.add(directory);
	const paths = housePaths(join(directory, "house"));
	await mkdir(paths.serviceDir, { recursive: true, mode: 0o700 });
	await writeFile(paths.integrations, `${JSON.stringify(integrations, null, 2)}\n`, { mode: 0o600 });
	if (roster !== undefined) {
		await writeFile(join(paths.serviceDir, "roster.json"), `${JSON.stringify(roster, null, 2)}\n`, { mode: 0o600 });
	}
	return paths;
}

const ROOM = { people: [{ name: "Denis", addedAt: "2026-10-01T00:00:00.000Z" }, { name: "Ilya" }] };

describe("the single-user cutover", () => {
	it("turns the one mapped actor into the owner, and deletes the roster it printed", async () => {
		const paths = await home(
			{
				integrations: {
					telegram: {
						enabled: true,
						connector: {
							user: {
								actors: { "8811": "Denis" },
								conversations: [{ externalConversationId: "-1001234", kind: "room" }],
								unattributed: true,
								approver: "8811",
							},
							events: { hooks: { "chat.message": "team-chat" } },
							state: ["status"],
							commands: ["stop"],
						},
					},
				},
			},
			ROOM,
		);

		const outcome = await cutOverSingleUser(paths);
		assert.deepEqual(outcome.integrations, [
			{ name: "telegram", owner: "8811", retired: ["actors", "unattributed", "approver"] },
		]);
		assert.deepEqual(outcome.roster, ["Denis", "Ilya"], "the names are reported before the file goes");

		// What the next boot reads: one owner, the rooms, and every other key the entry had.
		const user = (await readIntegrations(paths)).integrations.telegram?.connector?.user;
		assert.deepEqual(user, {
			owner: "8811",
			conversations: [{ externalConversationId: "-1001234", kind: "room" }],
		});
		const grant = (await readIntegrations(paths)).integrations.telegram?.connector;
		assert.deepEqual(grant?.events?.hooks, { "chat.message": "team-chat" });
		assert.deepEqual(grant?.commands, ["stop"]);

		// A file the boot no longer reads is a file whose owner thinks it still means something.
		await assert.rejects(() => readFile(join(paths.serviceDir, "roster.json"), "utf8"), /ENOENT/);
	});

	it("refuses several mapped actors and names them, writing nothing", async () => {
		const integrations = {
			integrations: {
				telegram: {
					enabled: true,
					connector: {
						user: { actors: { "8811": "Denis", "9999": "Ilya" }, conversations: [] },
						state: [],
						trustMarkers: false,
					},
				},
			},
		};
		const paths = await home(integrations, ROOM);
		const before = await readFile(paths.integrations, "utf8");

		await assert.rejects(
			() => cutOverSingleUser(paths),
			(error: Error) => {
				assert.match(error.message, /8811/);
				assert.match(error.message, /9999/);
				assert.match(error.message, /one owner/);
				return true;
			},
		);
		// The choice is the operator's, so nothing is applied — not the other entry, and not the roster.
		assert.equal(await readFile(paths.integrations, "utf8"), before);
		await readFile(join(paths.serviceDir, "roster.json"), "utf8");
	});

	it("leaves a home that has moved nothing at all, byte for byte", async () => {
		const paths = await home({
			integrations: {
				telegram: {
					enabled: true,
					connector: { user: { owner: "8811", conversations: [] }, state: [], trustMarkers: false },
				},
			},
		});
		const before = await readFile(paths.integrations, "utf8");
		assert.deepEqual(await cutOverSingleUser(paths), { integrations: [], roster: undefined });
		assert.equal(
			await readFile(paths.integrations, "utf8"),
			before,
			"a command that rewrites on every run is not run",
		);
	});

	it("keeps a user face with an empty map, minus the keys, and names no owner", async () => {
		// A connector whose map was empty allowed actorless words only: that is what the absent actor means now, so the
		// face survives with nothing to admit and the entry keeps its rooms.
		const paths = await home({
			integrations: {
				telegram: {
					enabled: true,
					connector: {
						user: { actors: {}, conversations: [{ externalConversationId: "8811", kind: "person" }] },
						state: [],
						trustMarkers: false,
					},
				},
			},
		});
		const outcome = await cutOverSingleUser(paths);
		assert.deepEqual(outcome.integrations, [{ name: "telegram", owner: undefined, retired: ["actors"] }]);
		assert.deepEqual((await readIntegrations(paths)).integrations.telegram?.connector?.user, {
			conversations: [{ externalConversationId: "8811", kind: "person" }],
		});
	});

	it("finishes off a roster a pre-split home still has at its root", async () => {
		// `roster.json` left `HOUSE_ENTRIES`, so the split migration no longer carries it. A root copy is exactly the file
		// this command exists to remove, and reading only `service/` would leave it behind.
		const paths = await home({ integrations: {} });
		await writeFile(join(paths.home, "roster.json"), JSON.stringify(ROOM), { mode: 0o600 });
		assert.deepEqual(await cutOverSingleUser(paths), { integrations: [], roster: ["Denis", "Ilya"] });
		await assert.rejects(() => readFile(join(paths.home, "roster.json"), "utf8"), /ENOENT/);
	});

	it("deletes a roster it cannot parse, and reports no names", async () => {
		// Nothing reads the file, so a corrupt one is not a reason to keep it: the answer is still "gone".
		const paths = await home({ integrations: {} });
		await writeFile(join(paths.serviceDir, "roster.json"), "{not json", { mode: 0o600 });
		assert.deepEqual(await cutOverSingleUser(paths), { integrations: [], roster: [] });
		await assert.rejects(() => readFile(join(paths.serviceDir, "roster.json"), "utf8"), /ENOENT/);
	});
});
