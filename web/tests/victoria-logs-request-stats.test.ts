import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildRequestStatsBuckets,
	createEmptyHttpRequestStats,
	getRequestStatsWindow,
	parseRequestStatsRange,
	parseRequestStatsRows,
} from "@/lib/victoria-logs";

const SERVICE_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("VictoriaLogs request stats", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("parses JSON lines and ignores malformed rows", () => {
		const rows = parseRequestStatsRows(
			[
				'{"_time":"2026-07-02T00:00:00Z","status":200,"requests":"10"}',
				"not-json",
				'{"_time":"2026-07-02T00:01:00Z","status":"500","requests":5}',
			].join("\n"),
		);

		expect(rows).toEqual([
			{
				_time: "2026-07-02T00:00:00Z",
				status: 200,
				requests: "10",
			},
			{
				_time: "2026-07-02T00:01:00Z",
				status: "500",
				requests: 5,
			},
		]);
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
		expect(parseRequestStatsRange("week")).toBe("week");
		expect(parseRequestStatsRange("90d")).toBe("7d");
		expect(parseRequestStatsRange(null)).toBe("7d");
	});

	it("uses a Monday UTC start for the week-to-date range", () => {
		const window = getRequestStatsWindow(
			"week",
			new Date("2026-07-02T12:34:00Z"),
		);

		expect(window.start.toISOString()).toBe("2026-06-29T00:00:00.000Z");
		expect(window.end.toISOString()).toBe("2026-07-02T12:34:00.000Z");
		expect(window.stepSeconds).toBe(1800);
	});

	it("handles Sunday and Monday UTC week boundaries", () => {
		expect(
			getRequestStatsWindow(
				"week",
				new Date("2026-07-05T23:59:59Z"),
			).start.toISOString(),
		).toBe("2026-06-29T00:00:00.000Z");
		expect(
			getRequestStatsWindow(
				"week",
				new Date("2026-07-06T00:00:00Z"),
			).start.toISOString(),
		).toBe("2026-07-06T00:00:00.000Z");
	});

	it("queries a week-to-date stats window with one LogSQL range filter", async () => {
		vi.stubEnv("VICTORIA_LOGS_URL", "http://victoria.test");
		vi.stubEnv("VICTORIA_LOGS_PRIVATE_URL", "");
		vi.resetModules();

		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			const query = url.searchParams.get("query");

			expect(url.pathname).toBe("/select/logsql/query");
			expect(url.searchParams.get("limit")).toBe("11200");
			expect(query).toBe(
				`service_id:${SERVICE_ID} log_type:http _time:[2026-06-29T00:00:00.000Z, 2026-07-02T12:34:00.000Z) | stats by (_time:30m, status) count() as requests | sort by (_time)`,
			);

			return new Response(
				'{"_time":"2026-07-02T12:30:00Z","status":"200","requests":"3"}\n',
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const { queryHttpRequestStats } = await import("@/lib/victoria-logs");
		const stats = await queryHttpRequestStats({
			serviceId: SERVICE_ID,
			range: "week",
			now: new Date("2026-07-02T12:34:00Z"),
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(stats).toMatchObject({
			range: "week",
			windowStart: "2026-06-29T00:00:00.000Z",
			windowEnd: "2026-07-02T12:34:00.000Z",
			stepSeconds: 1800,
			totalRequests: 3,
			statusCodes: ["200"],
		});
	});

	it("creates an empty non-breaking stats payload", () => {
		expect(
			createEmptyHttpRequestStats("1h", new Date("2026-07-02T01:00:00Z")),
		).toMatchObject({
			range: "1h",
			windowStart: "2026-07-02T00:00:00.000Z",
			windowEnd: "2026-07-02T01:00:00.000Z",
			stepSeconds: 60,
			totalRequests: 0,
			statusCodes: [],
			buckets: [],
		});
	});
});
