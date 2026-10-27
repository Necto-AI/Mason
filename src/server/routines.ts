/**
 * Routines: a scheduled prompt the agent writes for itself, as a file.
 *
 * A routine is `agent/routines/<name>.md` — YAML frontmatter saying what it is and when it runs, then the instruction
 * the turn is started with. The agent drafts one with the `write` tool it already has, a person edits it in their
 * editor, and both are the same file: what makes a routine a routine is that it is data mason reads at boot and not
 * code somebody deploys.
 *
 * It is read through the execution environment, like the skills, because `agent/` is on the tool machine's volume and a
 * `node:fs` read would work in the dev stack and find nothing in the deployment.
 *
 * **The file is the whole truth about `enabled`.** A routine is armed by editing it, so `HooksManager` is told the
 * definition came from a file (`source: "file"`) and keeps the persisted runtime state — fire count, last fire — while
 * ignoring the persisted switch. Otherwise a routine a person wrote `enabled: false` into would come back on the next
 * boot, because `service/data/hooks.json` still said `true` from the day it was armed. There is no second switch either:
 * `HooksManager.setEnabled()` refuses a routine, because an arm taken there would last until the boot that read the file
 * again.
 *
 * **A new or changed routine takes effect on restart.** The list is read once at boot, with the integrations, because
 * the timers are armed from it: a file written mid-turn is a promise for the next boot, not a timer that appears under a
 * running conversation. The `routines` skill (`skills/routines/SKILL.md`) is what tells the agent to say so.
 *
 * **Daily only**, and with no chat sentence in the person's prose: when the routine names a chat, the sentence telling
 * the model where to answer is appended here, in code. A delivery tool named by a prompt the model wrote itself is the
 * same authority problem as one named by an untrusted payload (`hooks.ts`, `deliveryToolOf`) — and it would win, since the
 * appended sentence is last and the first tool named is the one that delivers — so a body that names one is refused when
 * the file is parsed.
 */
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { deliveryToolOf, deliveryToolsIn, type EventHookConfig } from "./hooks.ts";
import type { Integration } from "./integrations.ts";
import { validateSchedule } from "./schedule.ts";

/** The longest prompt a routine may carry: a turn's instruction, not a document. */
export const ROUTINE_PROMPT_MAX_CHARS = 4_000;

/** The longest description, because it is read in a list. */
const DESCRIPTION_MAX_CHARS = 200;

/** The longest name: a file name, a hook id and a word a person types, all at once. */
const NAME_MAX_CHARS = 64;

/** A routine's name is a file's: lowercase kebab, so `routine-<name>` is an id nothing else can spell. */
const ROUTINE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A chat id as a chat renders it: Telegram's own, positive for a person and negative for a group. */
const CHAT_ID = /^-?\d+$/;

/**
 * The tool a routine's `chat` is answered with, written into the prompt by `parseRoutine` below.
 *
 * One spelling for the two readers: the prompt that tells the model where to answer, and the boot check that asks whether
 * that tool exists at all (`chatRoutineReports`).
 */
export const CHAT_DELIVERY_TOOL = "mcp__telegram__send_message";

/** A routine as a hook: everything `define()` needs, and nothing about when it has fired. */
export type RoutineHook = Omit<EventHookConfig, "fireCount">;

/**
 * One routine file, or the one reason it is not a routine. Every answer names the file, because a person reading a
 * report has to know which of their files to open.
 */
export function parseRoutine(text: string, filePath: string): { definition: RoutineHook } | { error: string } {
	const refuse = (reason: string): { error: string } => ({ error: `${filePath}: ${reason}` });
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text));
	} catch (error) {
		return refuse(`the frontmatter is not YAML (${error instanceof Error ? error.message : String(error)})`);
	}
	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	if (name === "") return refuse('no "name": a routine needs one, lowercase kebab (morning-brief)');
	if (!ROUTINE_NAME.test(name) || name.length > NAME_MAX_CHARS) {
		return refuse(
			`"${name}" is not a routine name: lowercase letters, digits and single dashes, at most ${NAME_MAX_CHARS}`,
		);
	}
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (description === "") return refuse('no "description": one line saying what the routine is for');
	if (description.length > DESCRIPTION_MAX_CHARS) {
		return refuse(
			`the description is ${description.length} characters; a list entry is at most ${DESCRIPTION_MAX_CHARS}`,
		);
	}
	const at = frontmatter.at;
	if (typeof at !== "string") return refuse('no "at": the wall-clock time it runs, "HH:MM" in 24 hours');
	const tz = frontmatter.tz;
	if (typeof tz !== "string") {
		return refuse('no "tz": an IANA zone, and there is no default, because "08:00" is a place and not an offset');
	}
	const days = parseDays(frontmatter.days);
	if ("error" in days) return refuse(days.error);
	const schedule = validateSchedule({ kind: "daily", at, tz, ...(days.days === undefined ? {} : { days: days.days }) });
	if ("error" in schedule) return refuse(schedule.error);
	const chat = frontmatter.chat === undefined ? undefined : String(frontmatter.chat).trim();
	if (chat !== undefined && !CHAT_ID.test(chat)) {
		return refuse('"chat" is not a chat id: digits, with a leading - for a group (-1001234567890)');
	}
	const enabled = frontmatter.enabled ?? false;
	if (typeof enabled !== "boolean") return refuse('"enabled" is true or false');
	const instruction = body.trim();
	if (instruction === "") {
		return refuse("the prompt after the frontmatter is empty: it is the instruction the turn is started with");
	}
	if (instruction.length > ROUTINE_PROMPT_MAX_CHARS) {
		return refuse(
			`the prompt is ${instruction.length} characters; a turn's instruction is at most ${ROUTINE_PROMPT_MAX_CHARS}`,
		);
	}
	// Where the answer goes is the file's `chat`, and it is appended below. A body that named a delivery tool as well would
	// be the first one `deliveryToolOf()` finds, so the prose the person wrote would decide over the field that was set —
	// the same authority problem as a tool named by an untrusted payload, with the file instead of the sender.
	const named = deliveryToolsIn(instruction);
	if (named.length > 0) {
		return refuse(
			`the prompt names ${named[0]}, which is where an answer is delivered: put the chat id in \`chat:\` and leave the prose to the work`,
		);
	}
	return {
		definition: {
			id: `routine-${name}`,
			name,
			description,
			enabled,
			schedule,
			source: "file",
			// The chat is named here rather than asked for in the prompt, so where the answer goes is the routine's own
			// instruction and never something the model or a payload decided.
			promptTemplate:
				chat === undefined ? instruction : `${instruction}\n\nSend the answer to chat ${chat} with ${CHAT_DELIVERY_TOOL}.`,
		},
	};
}

/** `days` is a comma list in the file (`1,2,3,4,5`), and a list of numbers by the time it reaches a schedule. */
function parseDays(raw: unknown): { days?: readonly number[] } | { error: string } {
	if (raw === undefined) return {};
	const tokens =
		typeof raw === "string"
			? raw.split(",").map((token) => token.trim())
			: typeof raw === "number"
				? [String(raw)]
				: undefined;
	if (tokens === undefined || tokens.some((token) => !/^\d$/.test(token))) {
		return { error: '"days" is a comma list of weekdays, 0 = Sunday … 6 = Saturday (1,2,3,4,5)' };
	}
	return { days: tokens.map(Number) };
}

/** What a boot learns from the routines directory: the definitions to register, and one line per file it skipped. */
export interface LoadedRoutines {
	readonly definitions: readonly RoutineHook[];
	/** One line per file that was skipped, naming the file and why. Never a boot failure: a bad routine is one routine. */
	readonly reports: readonly string[];
}

/**
 * Every routine under `dir`, sorted by file name, with one report line per file that is not one.
 *
 * A routine is named by its file: `morning-brief.md` says `name: morning-brief`, and a file whose frontmatter disagrees is
 * refused rather than renamed. Two names for one routine would be two answers to "which file is `routine-x`": the id is
 * built from the frontmatter, so a file named one thing and calling itself another arms a hook nobody can find.
 *
 * `taken` is the hook ids this boot already defines — the builtins — because `define()` replaces a hook of the same id
 * silently. A routine's id is `routine-<name>`, so no builtin collides with one today; the guard is the rule for the day
 * one is named `routine-<something>`, and it costs a line.
 *
 * Absent is not a failure: a home nobody has written a routine in has no `routines/` to mention. Neither is one file
 * that cannot be read — it is reported and skipped, so a bad file costs one routine and not the boot.
 */
export async function loadRoutines(
	env: ExecutionEnv,
	dir: string,
	context: Context,
	taken: readonly string[],
): Promise<LoadedRoutines> {
	const listing = await env.listDir(dir, context);
	if (!listing.ok) {
		if (listing.error.code === "not_found") return { definitions: [], reports: [] };
		throw new Error(`cannot scan ${dir} on the machine the tools run on: ${listing.error.message}`);
	}
	const files = listing.value
		.filter((entry) => entry.kind === "file" && entry.name.endsWith(".md") && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));

	const definitions: RoutineHook[] = [];
	const reports: string[] = [];
	// Who owns an id, and how a report says so: a builtin that `define()` would replace, or the file that got there first.
	const owners = new Map<string, string>(taken.map((id) => [id, "a builtin hook"]));
	for (const file of files) {
		const path = join(dir, file);
		const text = await env.readTextFile(path, context);
		if (!text.ok) {
			// A file that vanished between the listing and the read is one routine fewer, not a reason to refuse a boot.
			if (text.error.code === "not_found") continue;
			reports.push(`${path}: cannot be read: ${text.error.message}`);
			continue;
		}
		const parsed = parseRoutine(text.value, path);
		if ("error" in parsed) {
			reports.push(parsed.error);
			continue;
		}
		const stem = file.slice(0, -3);
		if (stem !== parsed.definition.name) {
			reports.push(
				`${path}: the frontmatter names "${parsed.definition.name}", and a routine is named by its file: rename the file to ${parsed.definition.name}.md, or the name to ${stem}`,
			);
			continue;
		}
		const owner = owners.get(parsed.definition.id);
		if (owner !== undefined) {
			reports.push(`${path}: ${parsed.definition.id} is already ${owner}; a routine may not take another hook's id`);
			continue;
		}
		owners.set(parsed.definition.id, `the routine in ${path}`);
		definitions.push(parsed.definition);
	}
	return { definitions, reports };
}

/**
 * One line per routine whose answer has nowhere to go.
 *
 * `chat` is delivered with the Telegram integration's message tool, and that tool exists only while an enabled integration
 * named `telegram` has a tools face. Without one the routine fires every morning into a tool that is not there: the model
 * is told to answer with something it does not have, and the brief is lost with nothing said. So the boot says it, once per
 * routine, where the operator and the agent already read what the boot reported.
 */
export function chatRoutineReports(
	definitions: readonly RoutineHook[],
	integrations: Record<string, Integration>,
): string[] {
	const telegram = integrations.telegram;
	if (telegram?.enabled === true && telegram.tools !== undefined) return [];
	return definitions
		.filter((definition) => deliveryToolOf(definition.promptTemplate) === CHAT_DELIVERY_TOOL)
		.map(
			(definition) =>
				`[routines] ${definition.id} answers in a chat, and no enabled integration named "telegram" lends ${CHAT_DELIVERY_TOOL}: every fire would deliver nowhere`,
		);
}
