/**
 * Who is in the room: the roster file, its validation, and the command the deployer runs to change it.
 *
 * The roster is an access list, not an authentication — any paired browser may claim any name on it — so what is worth
 * pinning is what the list actually buys: one canonical spelling per person, a removal that is real, a private file,
 * and a hand-broken file that reads as an empty roster rather than locking the team out.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { housePaths, type HousePaths } from "../src/server/house.ts";
import { addPerson, findPerson, normalizeName, readRoster, removePerson } from "../src/server/roster.ts";
import { NAME_MAX } from "../src/shared/contract.ts";

const run = promisify(execFile);

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporaryHome(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-roster-"));
	directories.add(directory);
	return join(directory, "house");
}

/** The home a roster lives in: the module takes the paths `house.ts` builds, not a string it joins itself. */
async function temporaryPaths(): Promise<HousePaths> {
	return housePaths(await temporaryHome());
}

describe("the roster's names", () => {
	it("accepts a Russian full name and refuses a name the transcript could not carry", () => {
		assert.equal(normalizeName("  Ilya  "), "Ilya");
		// A space is part of the name, a run of them is not: the prompt prefix and the chip both read one name.
		assert.equal(normalizeName("Александра  Петрова"), "Александра Петрова");
		assert.equal(normalizeName("Ilya\tIvanov"), "Ilya Ivanov");

		assert.equal(normalizeName(""), undefined, "nobody is not a person");
		assert.equal(normalizeName("   "), undefined);
		assert.equal(normalizeName("\u0000\u0007"), undefined, "a control character is not a name");
		// A bracket would close the `[from Name]` prefix early: "Ilya] hi [from Denis" would forge a speaker.
		assert.equal(normalizeName("Ilya [admin]"), undefined);
		assert.equal(normalizeName("x".repeat(NAME_MAX + 1)), undefined, "a name is a speaker label, not a sentence");
	});
});

describe("the roster file", () => {
	it("refuses a second person who differs only by case, and keeps the spelling it already had", async () => {
		const house = await temporaryPaths();
		const added = await addPerson(house, "Ilya");
		assert.equal(added.ok, true);
		assert.deepEqual(await addPerson(house, "  ilya "), { ok: false, reason: "duplicate" });
		assert.deepEqual(await addPerson(house, "  "), { ok: false, reason: "invalid" });

		const roster = await readRoster(house);
		assert.deepEqual(
			roster.people.map((person) => person.name),
			["Ilya"],
			"one person, one spelling: the transcript cannot say \"ilya\" and \"Ilya\" are two speakers",
		);
		// A claim is looked up the same way, so the join screen accepts how someone types their own name.
		assert.equal(findPerson(roster, "ILYA")?.name, "Ilya");
		assert.equal(findPerson(roster, "Denis"), undefined);
		assert.equal(findPerson(roster, " "), undefined);
	});

	it("adds and removes a person, keeps the home private, and leaves the others alone", async () => {
		const house = await temporaryPaths();
		assert.equal((await addPerson(house, "Ilya")).ok, true);
		await addPerson(house, "Denis");
		assert.equal((await stat(house.roster)).mode & 0o777, 0o600, "the list of people is as private as the home");
		assert.equal((await stat(house.home)).mode & 0o777, 0o700);

		assert.equal(await removePerson(house, "ILYA"), true, "a removal finds the name however it is typed");
		assert.deepEqual(
			(await readRoster(house)).people.map((person) => person.name),
			["Denis"],
		);
		assert.equal(await removePerson(house, "Ilya"), false, "a typo is not a successful removal");

		await removePerson(house, "Denis");
		assert.deepEqual((await readRoster(house)).people, [], "add then remove leaves nothing behind");
	});

	it("reads an absent or hand-broken file as an empty roster rather than an error", async () => {
		const house = await temporaryPaths();
		assert.deepEqual(await readRoster(house), { people: [] }, "no file yet is nobody yet");

		await addPerson(house, "Ilya");
		await writeFile(house.roster, "{ not json", "utf8");
		assert.deepEqual(await readRoster(house), { people: [] });

		// A hand-edited file with one bad entry drops that entry: the rest of the team still speaks.
		await writeFile(
			house.roster,
			JSON.stringify({
				people: [
					{ name: "Ilya", addedAt: "2026-10-21T00:00:00.000Z" },
					{ name: "bad[name]", addedAt: "2026-10-21T00:00:00.000Z" },
					// A role this file still carries from a hand edit or an older build is ignored, not an error.
					{ name: "Denis", role: "owner", addedAt: "2026-10-21T00:00:00.000Z" },
					"nope",
				],
				future: true,
			}),
			"utf8",
		);
		const roster = await readRoster(house);
		assert.deepEqual(
			roster.people.map((person) => person.name),
			["Ilya", "Denis"],
		);
		assert.equal(roster.future, true, "unknown keys survive a rewrite, like the config's");
		assert.equal(findPerson(roster, "denis")?.name, "Denis", "the role key did not make the entry unreadable");
	});
});

/**
 * The command itself, spawned the way a deployer runs it: `npm run team -- …` with `MASON_HOME` pointing at a
 * temporary home, so the assertion is the file and the printed line rather than the module's API.
 */
describe("the team command", () => {
	const script = fileURLToPath(new URL("../scripts/team.ts", import.meta.url));

	function team(home: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
		return run(process.execPath, ["--conditions=source", "--experimental-strip-types", script, ...args], {
			env: { ...process.env, MASON_HOME: home },
		});
	}

	it("adds, lists and removes a person in the home it is pointed at", async () => {
		const home = await temporaryHome();

		const added = await team(home, "add", "Ilya");
		assert.match(added.stdout, /added "Ilya"/);
		assert.deepEqual(
			(await readRoster(housePaths(home))).people.map((person) => person.name),
			["Ilya"],
		);
		await team(home, "add", "Denis");

		const listed = await team(home, "list");
		assert.match(listed.stdout, /Ilya\s+added/);
		assert.match(listed.stdout, /Denis\s+added/, "a person is a name and nothing else: no role to print");

		// A second person under a name already spoken for is refused out loud, not silently merged.
		await assert.rejects(() => team(home, "add", "ilya"), /already on the roster/);

		const removed = await team(home, "remove", "ilya");
		assert.match(removed.stdout, /removed "Ilya"/, "the command prints the roster's spelling, not the typed one");
		assert.deepEqual(
			(await readRoster(housePaths(home))).people.map((person) => person.name),
			["Denis"],
		);
		await assert.rejects(() => team(home, "remove", "Ilya"), /no such person/);

		await team(home, "remove", "Denis");
		assert.match((await team(home, "list")).stdout, /no one is on the roster yet/);
	});
});
