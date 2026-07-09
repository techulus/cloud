import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildTraefikServiceMatcher,
	createEmptyServiceMetrics,
	formatPromDuration,
	queryServiceMetrics,
} from "@/lib/victoria-metrics";

const SERVICE_ID = "123e4567-e89b-42d3-a456-426614174000";
const END_TS = Date.parse("2026-07-02T12:34:00Z") / 1000;

describe("VictoriaMetrics service metrics", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("formats Prometheus durations", () => {
		expect(formatPromDuration(60)).toBe("1m");
		expect(formatPromDuration(300)).toBe("5m");
		expect(formatPromDuration(7200)).toBe("2h");
		expect(formatPromDuration(45)).toBe("45s");
	});

	it("matches Traefik service labels with optional provider suffix", () => {
		expect(buildTraefikServiceMatcher(SERVICE_ID)).toBe(
			`^${SERVICE_ID}(@file)?$`,
		);
		expect(buildTraefikServiceMatcher("svc.1")).toBe("^svc\\.1(@file)?$");
	});

	it("creates an empty metrics payload", () => {
		expect(
			createEmptyServiceMetrics("1h", new Date("2026-07-02T01:00:00Z")),
		).toMatchObject({
			metricsEnabled: false,
			range: "1h",
			windowStart: "2026-07-02T00:00:00.000Z",
			windowEnd: "2026-07-02T01:00:00.000Z",
			stepSeconds: 60,
			totalRequests: 0,
			statusCodes: [],
			buckets: [],
		});
	});

	it("queries service metrics from VictoriaMetrics only", async () => {
		vi.stubEnv("VICTORIA_METRICS_URL", "http://victoria.test");
		vi.stubEnv("VICTORIA_METRICS_PRIVATE_URL", "");

		const queries: string[] = [];
		const starts: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			const query = url.searchParams.get("query") || "";
			queries.push(query);
			starts.push(url.searchParams.get("start") || "");

			expect(url.pathname).toBe("/api/v1/query_range");

			if (query.includes("traefik_service_requests_total")) {
				return jsonResponse([
					{
						metric: { code: "200" },
						values: [[END_TS, "3"]],
					},
				]);
			}
			if (query.includes("histogram_quantile(0.95")) {
				return jsonResponse([{ metric: {}, values: [[END_TS, "0.123"]] }]);
			}
			if (query.includes("traefik_service_responses_bytes_total")) {
				return jsonResponse([{ metric: {}, values: [[END_TS, "2048"]] }]);
			}
			if (query.includes("techulus_service_cpu_usage_percent")) {
				return jsonResponse([{ metric: {}, values: [[END_TS, "42"]] }]);
			}

			return jsonResponse([]);
		});
		vi.stubGlobal("fetch", fetchMock);

		const stats = await queryServiceMetrics({
			serviceId: SERVICE_ID,
			range: "24h",
			now: new Date("2026-07-02T12:34:00Z"),
		});

		expect(fetchMock).toHaveBeenCalledTimes(10);
		expect(queries.some((query) => query.includes("LogSQL"))).toBe(false);
		expect(queries).toContain(
			`sum by (code) (increase(traefik_service_requests_total{service=~"^${SERVICE_ID}(@file)?$"}[5m]))`,
		);
		expect(queries).toContain(
			`sum(avg_over_time(techulus_service_cpu_usage_percent{service_id="${SERVICE_ID}"}[5m]))`,
		);
		expect(queries).toContain(
			`sum(avg_over_time(techulus_service_memory_usage_percent{service_id="${SERVICE_ID}"}[5m]))`,
		);
		expect(
			starts.every((start) => start === String(END_TS - 24 * 60 * 60 + 5 * 60)),
		).toBe(true);
		expect(stats.totalRequests).toBe(3);
		expect(stats.statusCodes).toEqual(["200"]);
		expect(stats.buckets).toHaveLength(288);
		expect(stats.buckets[0]?.timestamp).toBe("2026-07-01T12:39:00.000Z");

		const lastBucket = stats.buckets.at(-1);
		expect(lastBucket).toMatchObject({
			totalRequests: 3,
			statuses: { "200": 3 },
			p95ResponseTimeMs: 123,
			egressBytesPerSecond: 2048,
			cpuUsagePercent: 42,
		});
	});
});

function jsonResponse(result: unknown[]) {
	return new Response(
		JSON.stringify({
			status: "success",
			data: { result },
		}),
	);
}
