/**
 * A schedule is a wall clock, so the tests are dates: the same `08:00` is a different instant in Moscow and in UTC,
 * and two days a year it is not an instant at all. Everything here is pure — `nextFireAt` takes the clock as an
 * argument — which is what lets the spring-forward and fall-back days be ordinary cases instead of two days a year
 * nobody can test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextFireAt, validateSchedule, wallClockSlot, type HookSchedule } from "../src/server/schedule.ts";

/** A daily schedule, with the pieces a test does not care about filled in. */
function daily(at: string, tz: string, days?: readonly number[]): HookSchedule {
	return { kind: "daily", at, tz, ...(days === undefined ? {} : { days }) };
}

function next(schedule: HookSchedule, iso: string): string {
	return nextFireAt(schedule, new Date(iso)).toISOString();
}

describe("nextFireAt()", () => {
	it("reads the schedule's own zone, not the process's", () => {
		// Moscow is UTC+3 all year: 08:00 there is 05:00Z, whatever the host's TZ is.
		assert.equal(next(daily("08:00", "Europe/Moscow"), "2026-10-19T04:00:00.000Z"), "2026-10-19T05:00:00.000Z");
		assert.equal(next(daily("08:00", "UTC"), "2026-10-19T04:00:00.000Z"), "2026-10-19T08:00:00.000Z");
		assert.equal(next(daily("08:00", "Asia/Tokyo"), "2026-10-18T23:30:00.000Z"), "2026-10-19T23:00:00.000Z");
	});

	it("is strictly after now, so a fire at the boundary is tomorrow's", () => {
		// Exactly at 08:00 Moscow: that fire is the one being answered, and the next is a day later.
		assert.equal(next(daily("08:00", "Europe/Moscow"), "2026-10-19T05:00:00.000Z"), "2026-10-20T05:00:00.000Z");
		// One millisecond earlier it is still today's.
		assert.equal(next(daily("08:00", "Europe/Moscow"), "2026-10-19T04:59:59.999Z"), "2026-10-19T05:00:00.000Z");
	});

	it("is tomorrow when today's time has already passed", () => {
		assert.equal(next(daily("08:00", "Europe/Moscow"), "2026-10-19T09:00:00.000Z"), "2026-10-20T05:00:00.000Z");
	});

	it("skips the days the schedule does not name, a week ahead if that is what it takes", () => {
		const weekdays = daily("09:30", "Europe/Moscow", [1, 2, 3, 4, 5]);
		// Friday 15:30 Moscow: the next weekday morning is Monday's.
		assert.equal(next(weekdays, "2026-10-23T12:30:00.000Z"), "2026-10-26T06:30:00.000Z");
		// Saturday: Monday again, and a Sunday schedule watching one weekday reaches a week out.
		assert.equal(next(weekdays, "2026-10-24T12:00:00.000Z"), "2026-10-26T06:30:00.000Z");
		assert.equal(next(daily("09:00", "UTC", [3]), "2026-10-21T09:00:00.000Z"), "2026-10-28T09:00:00.000Z");
	});

	it("fires once, at the transition, for a time the spring-forward day skips", () => {
		// Berlin, 2026-03-29: 02:00 becomes 03:00, so 02:30 never happens. The first instant that does is 03:00 CEST.
		assert.equal(next(daily("02:30", "Europe/Berlin"), "2026-03-28T12:00:00.000Z"), "2026-03-29T01:00:00.000Z");
		// The same day, and the one after, are ordinary again.
		assert.equal(next(daily("02:30", "Europe/Berlin"), "2026-03-29T02:00:00.000Z"), "2026-03-30T00:30:00.000Z");
		// The hour a zone skips can be the first of the day: Chile moves 00:00 to 01:00 on 2026-09-06.
		assert.equal(next(daily("00:00", "America/Santiago"), "2026-09-05T12:00:00.000Z"), "2026-09-06T04:00:00.000Z");
	});

	it("fires at the first of the two when the fall-back day repeats an hour", () => {
		// Berlin, 2026-10-25: 03:00 falls back to 02:00, so 02:30 happens twice. The first is 02:30 CEST (00:30Z).
		assert.equal(next(daily("02:30", "Europe/Berlin"), "2026-10-24T12:00:00.000Z"), "2026-10-25T00:30:00.000Z");
		// New York, 2026-11-01: 01:30 EDT is the first of its two, and a whole day later is a whole day later.
		assert.equal(next(daily("01:30", "America/New_York"), "2026-10-31T12:00:00.000Z"), "2026-11-01T05:30:00.000Z");
	});

	it("handles a zone whose clocks move by half an hour", () => {
		// Lord Howe, 2026-04-05: 02:00 becomes 01:30, so 01:45 happens twice and the first one is +11.
		assert.equal(next(daily("01:45", "Australia/Lord_Howe"), "2026-04-04T00:00:00.000Z"), "2026-04-04T14:45:00.000Z");
		// 2026-10-04: 02:00 becomes 02:30, so 02:15 never happens and 02:30 is the first instant that exists.
		assert.equal(next(daily("02:15", "Australia/Lord_Howe"), "2026-10-03T00:00:00.000Z"), "2026-10-03T15:30:00.000Z");
	});

	it("names a slot by the schedule's calendar date, so a retimed routine is still one fire a day", () => {
		const at = new Date("2026-10-20T05:00:00.000Z");
		// 05:00Z is 08:00 in Moscow on the 20th: the slot is the date, in that zone.
		assert.equal(wallClockSlot(daily("08:00", "Europe/Moscow"), at), "2026-10-20");
		// Retimed to 08:05 after 08:00 has fired: the same day, so the same slot and no second brief.
		assert.equal(wallClockSlot(daily("08:05", "Europe/Moscow"), at), "2026-10-20");
		// The same instant read in another zone is another date, and a fire a minute later is still the same one.
		assert.equal(wallClockSlot(daily("08:00", "UTC"), at), "2026-10-20");
		assert.equal(wallClockSlot(daily("08:00", "Europe/Moscow"), new Date("2026-10-20T05:00:59.000Z")), "2026-10-20");
		// And a zone across the date line is a different day at the same instant: 05:00Z is the 20th in Moscow, the 19th in
		// Los Angeles, so two homes' mornings are two slots rather than one.
		assert.equal(wallClockSlot(daily("08:00", "America/Los_Angeles"), at), "2026-10-19");
	});
});

describe("validateSchedule()", () => {
	it("accepts what a routine may write, and drops what it does not name", () => {
		assert.deepEqual(validateSchedule({ kind: "daily", at: "08:00", tz: "Europe/Moscow", extra: true }), {
			kind: "daily",
			at: "08:00",
			tz: "Europe/Moscow",
		});
		assert.deepEqual(validateSchedule({ kind: "daily", at: "23:59", tz: "UTC", days: [1, 3] }), {
			kind: "daily",
			at: "23:59",
			tz: "UTC",
			days: [1, 3],
		});
	});

	it("refuses what a timer cannot be armed from, and says which field", () => {
		const refused = (raw: unknown): string => {
			const result = validateSchedule(raw);
			assert.ok("error" in result, `expected a refusal for ${JSON.stringify(raw)}`);
			return result.error;
		};
		assert.match(refused("08:00"), /object/);
		assert.match(refused({ kind: "hourly", at: "08:00", tz: "UTC" }), /kind/);
		assert.match(refused({ kind: "daily", at: "8:00", tz: "UTC" }), /at/);
		assert.match(refused({ kind: "daily", at: "24:00", tz: "UTC" }), /at/);
		assert.match(refused({ kind: "daily", at: "08:60", tz: "UTC" }), /at/);
		assert.match(refused({ kind: "daily", at: "08:00" }), /tz/);
		// The only authority on a zone is `Intl`: a name it does not know is refused here, not at a fire time.
		assert.match(refused({ kind: "daily", at: "08:00", tz: "Mars/Olympus" }), /no time zone/);
		assert.match(refused({ kind: "daily", at: "08:00", tz: "UTC", days: [] }), /non-empty/);
		assert.match(refused({ kind: "daily", at: "08:00", tz: "UTC", days: [7] }), /not a weekday/);
		assert.match(refused({ kind: "daily", at: "08:00", tz: "UTC", days: ["1"] }), /not a weekday/);
		assert.match(refused({ kind: "daily", at: "08:00", tz: "UTC", days: [1, 1] }), /twice/);
	});
});
