/**
 * A wall-clock schedule: "every weekday at 08:00 in Europe/Moscow", and the next instant it means.
 *
 * A schedule is a time of day in a zone, not an interval. `intervalMs` counts from whenever the process happened to
 * start, so a restart moves the fire and a sleeping machine skips it; a wall clock does not care when the timer was
 * armed, only what the clock in that zone reads. There is therefore nothing here but arithmetic on instants — no
 * timers, no I/O, no state — which is what makes the two days a year that are not 24 hours long testable as data.
 *
 * **Daily only, on purpose.** A routine runs once a day (or on some days), so two routines cannot wake each other and
 * a schedule cannot loop. Hourly is a thing to add deliberately, with its own identity rule, not a flag on this one.
 *
 * **The two days that are not.**
 * - Spring forward: a wall-clock time that does not exist — 02:30 where the zone jumps 02:00 to 03:00 — fires at the
 *   first instant that does exist, which is the transition itself (03:00). It fires once, not twice.
 * - Fall back: a wall-clock time that exists twice — 02:30 where the zone falls back into 02:00 — fires at the first
 *   of the two, so a routine runs once either way.
 *
 * Zones come from `Intl` and nowhere else: the runtime's tz database is the one the host keeps current, and a cron
 * parser would be a dependency plus a dialect for one shape of schedule (`docs/research/grokbot-insights/12`, B).
 */

/** A daily schedule: a wall-clock time, optionally on a set of weekdays, in one zone. */
export interface HookSchedule {
	readonly kind: "daily";
	/** `HH:MM`, 24-hour, in `tz`. */
	readonly at: string;
	/** Weekdays it fires on, `0` = Sunday … `6` = Saturday. Absent means every day. */
	readonly days?: readonly number[];
	/** An IANA zone name (`Europe/Moscow`), never a UTC offset: a person means "08:00 where I am", not "08:00 UTC+3". */
	readonly tz: string;
}

const DAY_MS = 86_400_000;

/**
 * How far around the target instant the zone's offset is sampled, in milliseconds.
 *
 * The instant a wall clock names is the wall clock minus the offset in effect *at that instant*, and the offset is the
 * unknown. Sampling it either side of the target — and between, so a transition inside the half-day is seen on both
 * sides of it — gives every candidate answer without guessing which side of a transition the fire lands on.
 */
const OFFSET_PROBES_MS: readonly number[] = [-26 * 3_600_000, -13 * 3_600_000, 0, 13 * 3_600_000, 26 * 3_600_000];

/** The next instant strictly after `now` that matches the schedule. */
export function nextFireAt(schedule: HookSchedule, now: Date): Date {
	const [hour, minute] = atParts(schedule.at);
	const today = civilDayOf(schedule.tz, now.getTime());
	// Eight days, so a schedule that fires on one weekday a week always has an answer: today's time may have passed.
	for (let ahead = 0; ahead <= 7; ahead += 1) {
		const day = addDays(today, ahead);
		if (schedule.days !== undefined && !schedule.days.includes(weekdayOf(day))) continue;
		const fireAt = instantForWallClock(schedule.tz, day, hour, minute);
		if (fireAt > now.getTime()) return new Date(fireAt);
	}
	// Unreachable: seven days ahead is the same weekday, and its time is in the future.
	throw new Error(`no fire time for ${schedule.at} in ${schedule.tz} within a week`);
}

/**
 * The identity of one wall-clock slot: the calendar date the fire belongs to, as the schedule's own zone reads it.
 *
 * A schedule's fire is identified by the slot it was armed for, not by when the timer happened to run, so a restart
 * inside the same day does not fire twice — pi-durable never forgets a request id — while tomorrow is a new slot and
 * fires again. The date alone, without the time of day, is what makes a retimed routine one fire a day: moving 08:00 to
 * 08:05 after 08:00 already fired would otherwise be a second slot and a second brief. The trade is the other
 * direction, and it is the one to prefer — a routine retimed to later today fires tomorrow, because a duplicate brief
 * is worse than a late one. Two routines cannot collide in this key: the hook's id is in front of it.
 */
export function wallClockSlot(schedule: HookSchedule, at: Date): string {
	const parts = zonedParts(schedule.tz, at.getTime());
	return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * A schedule read from a file, or the one reason it cannot be. Validation is here rather than in the loader so the
 * refusal is a value: a file that names a zone this host does not know answers `{ error }` and is reported, instead of
 * throwing somewhere a fire is being armed.
 */
export function validateSchedule(raw: unknown): HookSchedule | { error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "schedule must be an object" };
	const fields = raw as Record<string, unknown>;
	if (fields.kind !== "daily") return { error: 'schedule.kind must be "daily"' };
	const at = fields.at;
	if (typeof at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
		return { error: 'schedule.at must be a wall-clock time, "HH:MM" in 24 hours' };
	}
	const tz = fields.tz;
	if (typeof tz !== "string" || tz.trim() === "") return { error: "schedule.tz must name an IANA time zone" };
	// The only authority on whether a zone exists: `Intl` throws for a name it does not know.
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
	} catch {
		return { error: `schedule.tz names no time zone this host knows: ${tz}` };
	}
	const days = fields.days;
	if (days === undefined) return { kind: "daily", at, tz };
	if (!Array.isArray(days) || days.length === 0) {
		return { error: "schedule.days must be a non-empty list of weekdays, 0 = Sunday … 6 = Saturday" };
	}
	const seen = new Set<number>();
	for (const day of days) {
		if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
			return { error: `schedule.days holds ${String(day)}, which is not a weekday from 0 to 6` };
		}
		if (seen.has(day)) return { error: `schedule.days names ${day} twice` };
		seen.add(day);
	}
	return { kind: "daily", at, tz, days: days as number[] };
}

/** A calendar date in a zone, with no time of day: what a schedule fires within. */
interface CivilDay {
	readonly year: number;
	readonly month: number;
	readonly day: number;
}

/**
 * The instant on `day` whose wall clock reads `hour:minute` in `tz`, under the two rules in this module's header.
 *
 * `target` is that wall clock written as if it were UTC, so an offset is what stands between the two. Each sampled
 * offset gives one candidate; one of them reading the target back is the answer, and there being two (a fall-back) is
 * why the earliest wins.
 */
function instantForWallClock(tz: string, day: CivilDay, hour: number, minute: number): number {
	const target = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
	const offsets = new Set(OFFSET_PROBES_MS.map((probe) => offsetAt(tz, target + probe)));
	const candidates = [...offsets].map((offset) => target - offset);
	const exact = candidates.filter((candidate) => wallClockOf(tz, candidate) === target);
	if (exact.length > 0) return Math.min(...exact);

	// The wall clock skips the target (a spring-forward gap). The transition is the first instant that exists, and it
	// lies between the candidate just before the jump and the one just after it.
	const below = candidates.filter((candidate) => wallClockOf(tz, candidate) < target).sort((a, b) => b - a)[0];
	const above = candidates.filter((candidate) => wallClockOf(tz, candidate) > target).sort((a, b) => a - b)[0];
	if (below === undefined || above === undefined) {
		// A zone that changed its offset twice inside one sampled half-day leaves one side unsampled. There is nothing
		// left to prefer, and a scheduler is the wrong place to throw, so the closest candidate is the answer.
		return Math.min(...candidates);
	}
	// The offset steps up exactly once between the two, so bisecting on it lands on the transition instant itself.
	const old = offsetAt(tz, below);
	let low = below;
	let high = above;
	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2);
		if (offsetAt(tz, middle) === old) low = middle;
		else high = middle;
	}
	return high;
}

/**
 * What the zone's clock reads at `at`, written as if it were UTC: the wall clock and the instant minus it is the
 * offset. Whole seconds, because the formatting drops milliseconds and an offset is never finer than that.
 */
function wallClockOf(tz: string, at: number): number {
	const parts = zonedParts(tz, at);
	return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function offsetAt(tz: string, at: number): number {
	return wallClockOf(tz, at) - Math.floor(at / 1_000) * 1_000;
}

interface ZonedParts {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
}

/** One formatter per zone: `Intl.DateTimeFormat` construction is the expensive half, and a schedule asks often enough. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
	const known = formatters.get(tz);
	if (known !== undefined) return known;
	// `h23`, not `hour12: false`: the latter reads midnight as 24 in some locales, and a day with an hour 24 in it is
	// a day whose arithmetic is wrong by one.
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	formatters.set(tz, formatter);
	return formatter;
}

function zonedParts(tz: string, at: number): ZonedParts {
	const fields = new Map(formatterFor(tz).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
	const number = (type: string): number => Number(fields.get(type));
	return {
		year: number("year"),
		month: number("month"),
		day: number("day"),
		hour: number("hour"),
		minute: number("minute"),
		second: number("second"),
	};
}

function civilDayOf(tz: string, at: number): CivilDay {
	const { year, month, day } = zonedParts(tz, at);
	return { year, month, day };
}

function addDays(day: CivilDay, days: number): CivilDay {
	const moved = new Date(Date.UTC(day.year, day.month - 1, day.day) + days * DAY_MS);
	return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

function weekdayOf(day: CivilDay): number {
	return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
}

function atParts(at: string): [number, number] {
	const [hour, minute] = at.split(":");
	return [Number(hour), Number(minute)];
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
