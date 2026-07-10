import { describe, expect, it } from "vitest";
import {
	addMilliseconds,
	addUtcDays,
	DAY_IN_MILLISECONDS,
	differenceInElapsedDays,
	differenceInElapsedHours,
	differenceInMilliseconds,
	formatCompactDate,
	formatCompactDateTime,
	formatDate,
	formatDateTime,
	formatDateTimeUtc,
	formatElapsedDuration,
	formatElapsedDurationBetween,
	formatPreciseDateTime,
	formatRelativeTime,
	formatTime,
	getTimestamp,
	HOUR_IN_MILLISECONDS,
	isDateAfter,
	isDateBefore,
	isExpired,
	subtractMilliseconds,
	subtractUtcDays,
	toDate,
} from "@/lib/date";

const TIMESTAMP = "2026-07-10T04:05:06.789Z";
const UTC = { timeZone: "UTC" } as const;

describe("date formatting", () => {
	it("uses the shared display formats", () => {
		expect(formatDate(TIMESTAMP, UTC)).toBe("Jul 10, 2026");
		expect(formatDateTime(TIMESTAMP, UTC)).toBe("Jul 10, 2026, 04:05");
		expect(formatPreciseDateTime(TIMESTAMP, UTC)).toBe(
			"Jul 10, 2026, 04:05:06",
		);
		expect(formatTime(TIMESTAMP, UTC)).toBe("04:05:06");
		expect(formatTime("2026-07-10T00:00:00Z", UTC)).toBe("00:00:00");
		expect(formatCompactDate(TIMESTAMP, UTC)).toBe("Jul 10");
		expect(formatCompactDateTime(TIMESTAMP, UTC)).toBe("Jul 10, 04:05");
		expect(formatDateTimeUtc(TIMESTAMP)).toBe("Jul 10, 2026, 04:05 UTC");
	});

	it("handles missing and invalid inputs consistently", () => {
		expect(formatDate(null)).toBe("—");
		expect(formatDateTime("not-a-date", { fallback: "Unknown" })).toBe(
			"Unknown",
		);
		expect(toDate(undefined)).toBeNull();
		expect(toDate("not-a-date")).toBeNull();
	});

	it("clones Date inputs instead of returning mutable shared instances", () => {
		const source = new Date(TIMESTAMP);
		const parsed = toDate(source);

		expect(parsed).toEqual(source);
		expect(parsed).not.toBe(source);
	});
});

describe("relative time and durations", () => {
	const now = "2026-07-10T12:00:00Z";

	it("formats past and future relative values", () => {
		expect(formatRelativeTime("2026-07-10T11:59:31Z", { now })).toBe(
			"just now",
		);
		expect(formatRelativeTime("2026-07-10T11:48:00Z", { now })).toBe("12m ago");
		expect(formatRelativeTime("2026-07-10T16:00:00Z", { now })).toBe("in 4h");
		expect(formatRelativeTime("2026-07-06T12:00:00Z", { now })).toBe("4d ago");
		expect(
			formatRelativeTime("2026-07-01T12:00:00Z", { now, timeZone: "UTC" }),
		).toBe("Jul 1, 2026");
		expect(
			formatRelativeTime("2026-07-03T12:00:00Z", { now, timeZone: "UTC" }),
		).toBe("Jul 3, 2026");
	});

	it("formats elapsed durations at standard boundaries", () => {
		expect(formatElapsedDuration(42_999)).toBe("42s");
		expect(formatElapsedDuration(192_000)).toBe("3m 12s");
		expect(formatElapsedDuration(3_790_000)).toBe("1h 03m 10s");
		expect(formatElapsedDuration(-1_000)).toBe("0s");
		expect(formatElapsedDuration(Number.NaN, { fallback: "Unknown" })).toBe(
			"Unknown",
		);
	});

	it("formats a running or completed interval", () => {
		expect(
			formatElapsedDurationBetween(
				"2026-07-10T11:58:00Z",
				"2026-07-10T12:00:12Z",
			),
		).toBe("2m 12s");
		expect(
			formatElapsedDurationBetween("2026-07-10T11:58:00Z", null, { now }),
		).toBe("2m 0s");
		expect(formatElapsedDurationBetween("invalid", null, { now })).toBe("—");
	});
});

describe("date comparisons and arithmetic", () => {
	it("compares absolute instants and treats the expiry boundary as expired", () => {
		const earlier = "2026-07-10T11:00:00Z";
		const later = "2026-07-10T12:00:00Z";

		expect(isDateBefore(earlier, later)).toBe(true);
		expect(isDateAfter(later, earlier)).toBe(true);
		expect(isExpired(later, later)).toBe(true);
		expect(isExpired(later, earlier)).toBe(false);
		expect(isExpired("invalid", later)).toBe(true);
		expect(isExpired(null, later)).toBe(true);
		expect(isExpired(undefined, later)).toBe(true);
		expect(() => isDateBefore("invalid", later)).toThrow("Invalid date");
		expect(() => isDateAfter(1e20, later)).toThrow("Invalid date");
	});

	it("adds and subtracts elapsed milliseconds", () => {
		const date = new Date("2026-07-10T12:00:00Z");

		expect(addMilliseconds(date, HOUR_IN_MILLISECONDS).toISOString()).toBe(
			"2026-07-10T13:00:00.000Z",
		);
		expect(subtractMilliseconds(date, HOUR_IN_MILLISECONDS).toISOString()).toBe(
			"2026-07-10T11:00:00.000Z",
		);
		expect(date.toISOString()).toBe("2026-07-10T12:00:00.000Z");
	});

	it("uses UTC calendar days without mutating the source", () => {
		const date = new Date("2026-03-08T06:30:00Z");

		expect(addUtcDays(date, 1).toISOString()).toBe("2026-03-09T06:30:00.000Z");
		expect(subtractUtcDays(date, 7).toISOString()).toBe(
			"2026-03-01T06:30:00.000Z",
		);
		expect(date.toISOString()).toBe("2026-03-08T06:30:00.000Z");
	});

	it("calculates elapsed differences and timestamps", () => {
		const earlier = "2026-07-08T00:00:00Z";
		const later = "2026-07-10T12:00:00Z";

		expect(differenceInElapsedHours(later, earlier)).toBe(60);
		expect(differenceInElapsedDays(later, earlier)).toBe(2.5);
		expect(() => differenceInMilliseconds(later, 1e20)).toThrow("Invalid date");
		expect(getTimestamp(later)).toBe(Date.parse(later));
		expect(getTimestamp("invalid", 0)).toBe(0);
		expect(DAY_IN_MILLISECONDS).toBe(24 * HOUR_IN_MILLISECONDS);
	});

	it("rejects invalid arithmetic inputs", () => {
		expect(() => addMilliseconds("invalid", 1)).toThrow("Invalid date");
		expect(() => addMilliseconds(TIMESTAMP, 1.5)).toThrow(
			"amount must be an integer",
		);
		expect(() => addMilliseconds(TIMESTAMP, 1e20)).toThrow(
			"Date arithmetic produced an out-of-range date",
		);
		expect(() => addUtcDays(TIMESTAMP, 0.5)).toThrow("days must be an integer");
		expect(() => addUtcDays(TIMESTAMP, Number.NaN)).toThrow(
			"days must be a finite number",
		);
		expect(() => subtractUtcDays(TIMESTAMP, 99_999_999_999)).toThrow(
			"Date arithmetic produced an out-of-range date",
		);
	});

	it("keeps local and explicit UTC formatter cache entries separate", () => {
		const nearMidnight = "2026-07-10T02:00:00Z";

		expect(formatDate(nearMidnight)).toBe("Jul 9, 2026");
		expect(formatDate(nearMidnight, UTC)).toBe("Jul 10, 2026");
	});
});
