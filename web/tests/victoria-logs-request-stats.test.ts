import { describe, expect, it } from "vitest";
import {
	buildRequestStatsBuckets,
	createEmptyHttpRequestStats,
	parseRequestStatsRange,
	parseRequestStatsRows,
	sumRequestStatsRows,
} from "@/lib/victoria-logs";

describe("VictoriaLogs request stats", () => {
	it("parses JSON lines and ignores malformed rows", () => {
		const rows = parseRequestStatsRows(
			[
				'{"_time":"2026-07-02T00:00:00Z","requests":"10","errors":2}',
				"not-json",
				'{"_time":"2026-07-02T00:01:00Z","requests":5,"errors":"1"}',
			].join("\n"),
		);

		expect(rows).toHaveLength(2);
		expect(sumRequestStatsRows(rows)).toEqual({ requests: 15, errors: 3 });
	});

	it("builds complete buckets and fills gaps with zeroes", () => {
		const buckets = buildRequestStatsBuckets(
			[
				{ _time: "2026-07-02T00:00:10Z", requests: "3", errors: 0 },
				{ _time: "2026-07-02T00:02:05Z", requests: 7, errors: "2" },
			],
			{
				start: new Date("2026-07-02T00:00:00Z"),
				end: new Date("2026-07-02T00:02:30Z"),
				stepSeconds: 60,
			},
		);

		expect(buckets).toEqual([
			{
				timestamp: "2026-07-02T00:00:00.000Z",
				requests: 3,
				errors: 0,
			},
			{
				timestamp: "2026-07-02T00:01:00.000Z",
				requests: 0,
				errors: 0,
			},
			{
				timestamp: "2026-07-02T00:02:00.000Z",
				requests: 7,
				errors: 2,
			},
		]);
	});

	it("falls back to the default range for unsupported values", () => {
		expect(parseRequestStatsRange("7d")).toBe("7d");
		expect(parseRequestStatsRange("90d")).toBe("7d");
		expect(parseRequestStatsRange(null)).toBe("7d");
	});

	it("creates an empty non-breaking stats payload", () => {
		expect(createEmptyHttpRequestStats("1h")).toMatchObject({
			range: "1h",
			stepSeconds: 60,
			currentWindowSeconds: 300,
			totalRequests: 0,
			currentRequestsPerSecond: 0,
			currentErrorsPerSecond: 0,
			buckets: [],
		});
	});
});
