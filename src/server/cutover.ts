/**
 * The single-user cutover: the files a room needed, and what they become (#126, #127).
 *
 * mason worked for a home with a room in it — a `roster.json` of names, an actor mapping per connector, a named
 * approver — and it now works for one person. Three pieces of that are configuration rather than code, so they cannot
 * be fixed by deleting a module: `connector.user` blocks name an actor map, an `unattributed` posture and an `approver`,
 * and `service/roster.json` is a file whose owner believes it still decides who may speak.
 *
 * This module is what `npm run doctor -- migrate` runs for them, and it is the doctor's shape rather than the boot's:
 * one-way, idempotent, and never on start. A server that rewrote its operator's files on boot would be a server that
 * edits his home, and the refusal it would hit instead — a boot that reads a retired key — is the one that names this
 * command.
 *
 * What the rewrite is:
 *
 * - **`connector.user.actors`** is a map from external actor ids to names, and the home held one person. One mapped
 *   actor becomes `owner`, which is the id itself — the name was only ever a label for it. Several mapped actors are a
 *   **refusal**, not a guess: deciding which of two people the bot works for is the operator's, and a migration that
 *   picked the first would be a migration that silently hands a stranger's chat to the owner's voice.
 * - **`unattributed`** goes with no replacement, because it was a posture and there is now one: an actorless submission
 *   is accepted, and an actor that is not the owner is refused.
 * - **`approver`** goes as well. Authority to answer a permission request is the `approve` grant on a device, or the
 *   connector's own `owner` actor, and there is no per-name approver to configure.
 * - **`service/roster.json`** is printed and then deleted. A file the boot no longer reads is a file whose owner thinks
 *   it still means something, and keeping it would leave one home with two places that answer "who is this for".
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { RETIRED_USER_KEYS } from "./connectors.ts";
import type { HousePaths } from "./house.ts";

/** One entry's rewrite: the owner it became, and the keys that went. */
export interface UserGrantCutover {
	readonly name: string;
	/** The actor id the entry's owner became. `undefined` when the map was empty: the entry keeps a face and no voice. */
	readonly owner: string | undefined;
	/** The retired keys that were removed, in the one order this module and the boot agree on. */
	readonly retired: readonly string[];
}

/** What one run of the cutover came to. */
export interface CutoverOutcome {
	readonly integrations: readonly UserGrantCutover[];
	/** The names `roster.json` held — in `service/` or at the home root — when there was one to remove. */
	readonly roster: readonly string[] | undefined;
}

/**
 * `roster.json`: not a path the layout has any more, only a file this command finishes off.
 *
 * Two places, because a home from before the split never had it moved: `HOUSE_ENTRIES` no longer lists it, so a root
 * copy is left where it was and would otherwise survive the cutover as a file nothing reads.
 */
function rosterPaths(paths: HousePaths): string[] {
	return [join(paths.serviceDir, "roster.json"), join(paths.home, "roster.json")];
}

/**
 * Move a home's retired single-user configuration forward, or refuse and change nothing.
 *
 * The refusal is checked over every entry before a single byte is written: an operator with three connectors should fix
 * them in one pass, and a half-applied cutover is the state nobody can reason about afterwards.
 */
export async function cutOverSingleUser(paths: HousePaths): Promise<CutoverOutcome> {
	const rewritten = await rewriteUserGrants(paths);
	const roster = await retireRoster(paths);
	return { integrations: rewritten, roster };
}

async function rewriteUserGrants(paths: HousePaths): Promise<UserGrantCutover[]> {
	const text = await readFile(paths.integrations, "utf8").catch((error: unknown) => {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT")
			return undefined;
		throw error;
	});
	if (text === undefined) return [];
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) return [];
	const file = parsed as Record<string, unknown>;
	const declared = file.integrations;
	if (typeof declared !== "object" || declared === null || Array.isArray(declared)) return [];

	const rewritten: Record<string, unknown> = { ...(declared as Record<string, unknown>) };
	const outcome: UserGrantCutover[] = [];
	const ambiguous: string[] = [];
	for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
		const entry = asRecord(value);
		const block = entry === undefined ? undefined : asRecord(asRecord(entry.connector)?.user);
		if (entry === undefined || block === undefined) continue;
		const retired = RETIRED_USER_KEYS.filter((key) => block[key] !== undefined);
		if (retired.length === 0) continue;
		const actors = asRecord(block.actors);
		const candidates = actors === undefined ? [] : Object.keys(actors);
		if (candidates.length > 1) {
			ambiguous.push(`"${name}" maps ${candidates.join(", ")}`);
			continue;
		}
		const owner = candidates[0];
		const kept = { ...block };
		for (const key of RETIRED_USER_KEYS) delete kept[key];
		const user = owner === undefined ? kept : { owner, ...kept };
		rewritten[name] = { ...entry, connector: { ...(entry.connector as Record<string, unknown>), user } };
		outcome.push({ name, owner, retired });
	}
	if (ambiguous.length > 0) {
		throw new Error(
			`${paths.integrations}: a single-user home has one owner, and these connectors map more than one actor: ` +
				`${ambiguous.join("; ")}. Leave the one that is the person this bot works for, delete the rest, and run ` +
				"this again",
		);
	}
	if (outcome.length === 0) return [];
	await writeFileAtomic(paths.integrations, { ...file, integrations: rewritten });
	return outcome;
}

/**
 * Print the roster's names and delete the file.
 *
 * A file that cannot be read is still deleted: it is not configuration any more, and its contents were the reason it
 * mattered. What it held is reported so the names are not lost silently — the operator is the one who knows which of
 * them this bot now works for, and `agent/profile.md` is where that lives.
 */
async function retireRoster(paths: HousePaths): Promise<string[] | undefined> {
	const names: string[] = [];
	let found = false;
	for (const path of rosterPaths(paths)) {
		const text = await readFile(path, "utf8").catch(() => undefined);
		if (text === undefined) continue;
		found = true;
		try {
			const parsed: unknown = JSON.parse(text);
			const people = asRecord(parsed)?.people;
			if (Array.isArray(people)) {
				for (const person of people) {
					const name = asRecord(person)?.name;
					if (typeof name === "string") names.push(name);
				}
			}
		} catch {
			// A file that is not JSON held no names to print. It is still removed: nothing reads it.
		}
		await rm(path, { force: true });
	}
	return found ? names : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}
