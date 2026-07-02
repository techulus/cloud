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
				'{"_time":"2026-07-02T00:00:00Z","status":200,"requests":"10"}',
				"not-json",
				'{"_time":"2026-07-02T00:01:00Z","status":"500","requests":5}',
			].join("\n"),
		);

		expect(rows).toHaveLength(2);
		expect(sumRequestStatsRows(rows)).toEqual({
			requests: 15,
			statuses: { "200": 10, "500": 5 },
		});
	});

	it("builds complete buckets and fills gaps with zeroes", () => {
		const buckets = buildRequestStatsBuckets(
			[
				{ _time: "2026-07-02T00:00:10Z", status: "200", requests: "3" },
				{ _time: "2026-07-02T00:02:05Z", status: "404", requests: 7 },
				{ _time: "2026-07-02T00:02:15Z", status: "500", requests: "2" },
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
				totalRequests: 3,
				statuses: { "200": 3 },
			},
			{
				timestamp: "2026-07-02T00:01:00.000Z",
				totalRequests: 0,
				statuses: {},
			},
			{
				timestamp: "2026-07-02T00:02:00.000Z",
				totalRequests: 9,
				statuses: { "404": 7, "500": 2 },
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
			statusCodes: [],
			currentStatuses: [],
			buckets: [],
		});
	});
});
