/**
 * Who is in the room.
 *
 * mason has one agent, one conversation and one transcript. A team needs the third thing a single-owner install never
 * needed: a name on each message, so "Ilya asked for the alert thresholds" is a fact rather than a guess the model has
 * to reconstruct from context. The roster is that list of names — a file Denis edits, not an account database.
 *
 * What this is not: authentication. Any credential that reaches the server can pick any name on the roster and become
 * it. That is the honest trade of a name-only join screen (Zoom's shape), and it is correct for a team that already
 * trusts each other. The roster still earns its keep: it is the access list (delete a name and that identity is gone),
 * it keeps names canonical (no "ilya" vs "Ilya" in one transcript), and it makes the author on every message a value
 * the server chose rather than a string the client made up.
 *
 * The file sits beside `config.json` in the service half of the home — `house.ts` builds the path — is written
 * atomically, and is read per request: removing a person lands on the next one, like revoking a token.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { NAME_MAX } from "../shared/contract.ts";
import type { HousePaths } from "./house.ts";

/** One person the agent works with. */
export interface Person {
	readonly name: string;
	readonly addedAt: string;
}

/** `~/.mason/service/roster.json`. Unknown keys survive a rewrite, the same way the config file's do. */
export interface Roster {
	readonly people: readonly Person[];
	readonly [key: string]: unknown;
}

/** A person as the wire carries it to the picker: the roster's spelling of the name, and nothing else. */
export interface WirePerson {
	readonly name: string;
}

/**
 * A name the transcript can carry: no control characters, no brackets (the prompt prefix is `[from Name]`), no runs of
 * whitespace, and not empty after trimming. Inner spaces stay, because a Russian full name has them.
 */
export function normalizeName(raw: string): string | undefined {
	const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	if (trimmed === "") return undefined;
	if (trimmed.length > NAME_MAX) return undefined;
	if (/[[\]]/.test(trimmed)) return undefined;
	return trimmed;
}

/**
 * Whether a stored entry is a person. A file hand-edited before the shape settled may still carry a `role` key; it is
 * ignored rather than read, so an old roster keeps working.
 */
function isPerson(value: unknown): value is Person {
	if (typeof value !== "object" || value === null) return false;
	const person = value as Record<string, unknown>;
	return (
		typeof person.name === "string" &&
		normalizeName(person.name) === person.name &&
		typeof person.addedAt === "string"
	);
}

export async function readRoster(paths: HousePaths): Promise<Roster> {
	try {
		const parsed: unknown = JSON.parse(await readFile(paths.roster, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return { people: [] };
		const { people: declared, ...rest } = parsed as Record<string, unknown>;
		// A hand-edited file with a typo must not lock the team out: a broken entry is dropped, the rest still count.
		const people = Array.isArray(declared) ? declared.filter(isPerson) : [];
		return { ...rest, people };
	} catch {
		return { people: [] };
	}
}

async function writeRoster(paths: HousePaths, roster: Roster): Promise<void> {
	await mkdir(dirname(paths.roster), { recursive: true, mode: 0o700 });
	const temporary = `${paths.roster}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(roster, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, paths.roster);
	await chmod(dirname(paths.roster), 0o700).catch(() => {});
	await chmod(paths.roster, 0o600).catch(() => {});
}

/** Case-insensitive: two people may not differ only by a capital letter, or the transcript would lie about who spoke. */
export function findPerson(roster: Roster, raw: string): Person | undefined {
	const wanted = normalizeName(raw)?.toLocaleLowerCase();
	if (wanted === undefined) return undefined;
	return roster.people.find((person) => person.name.toLocaleLowerCase() === wanted);
}

/**
 * The person a claim names, or `undefined` when the roster no longer holds it.
 *
 * A claim is fixed in a signed cookie and outlives its roster entry, so every gate that reads one asks this: a removed
 * person keeps their cookie and loses the place. Reading the file here is what makes a removal land on the next
 * request rather than on the next restart.
 */
export async function claimedPerson(paths: HousePaths, claimed: string | undefined): Promise<Person | undefined> {
	if (claimed === undefined) return undefined;
	return findPerson(await readRoster(paths), claimed);
}

/** The roster as the picker reads it. The mapping is here so the wire has one shape of a person, not one per route. */
export function peopleOnWire(roster: Roster): WirePerson[] {
	return roster.people.map((person) => ({ name: person.name }));
}

export type AddResult =
	| { readonly ok: true; readonly person: Person }
	| { readonly ok: false; readonly reason: "invalid" | "duplicate" };

export async function addPerson(paths: HousePaths, raw: string): Promise<AddResult> {
	const name = normalizeName(raw);
	if (name === undefined) return { ok: false, reason: "invalid" };
	const roster = await readRoster(paths);
	if (findPerson(roster, name) !== undefined) return { ok: false, reason: "duplicate" };
	const person: Person = { name, addedAt: new Date().toISOString() };
	await writeRoster(paths, { ...roster, people: [...roster.people, person] });
	return { ok: true, person };
}

/** `false` when no such name: a typo must not read as a successful removal, and a person who stays keeps their access. */
export async function removePerson(paths: HousePaths, raw: string): Promise<boolean> {
	const roster = await readRoster(paths);
	const person = findPerson(roster, raw);
	if (person === undefined) return false;
	await writeRoster(paths, { ...roster, people: roster.people.filter((entry) => entry.name !== person.name) });
	return true;
}
