import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildTraefikServiceMatcher,
	createEmptyServiceMetrics,
	formatPromDuration,
	queryServiceMetrics,
} from "@/lib/victoria-metrics";

const SERVICE_ID = "123e4567-e89b-42d3-a456-426614174000";
const END_TS = Date.parse("2026-07-02T12:30:00Z") / 1000;

describe("VictoriaMetrics service metrics", () => {
	afterEach(() => {
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
			totalIngressBytes: null,
			totalEgressBytes: null,
			statusCodes: [],
			buckets: [],
		});
	});

	it("queries service metrics from VictoriaMetrics only", async () => {
		vi.stubEnv("VICTORIA_METRICS_URL", "http://victoria.test");
		vi.stubEnv("VICTORIA_METRICS_PRIVATE_URL", "");

		const queries: string[] = [];
		const starts: string[] = [];
		const instantTimes: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			const query = url.searchParams.get("query") || "";
			queries.push(query);
			if (url.pathname === "/api/v1/query_range") {
				starts.push(url.searchParams.get("start") || "");
			}

			expect(["/api/v1/query", "/api/v1/query_range"]).toContain(url.pathname);

			if (url.pathname === "/api/v1/query") {
				instantTimes.push(url.searchParams.get("time") || "");
				if (query.includes("traefik_service_requests_bytes_total")) {
					return instantJsonResponse("460");
				}
				if (query.includes("traefik_service_responses_bytes_total")) {
					return instantJsonResponse("683051");
				}
			}

			if (query.includes("traefik_service_requests_total")) {
				return jsonResponse([
					{
						metric: { code: "200" },
						values: [[END_TS, "3"]],
					},
					{
						metric: { code: "204" },
						values: [[END_TS, "2"]],
					},
					{
						metric: { code: "301" },
						values: [[END_TS, "1"]],
					},
					{
						metric: { code: "404" },
						values: [[END_TS, "4"]],
					},
					{
						metric: { code: "500" },
						values: [[END_TS, "5"]],
					},
					{
						metric: { code: "502" },
						values: [[END_TS, "6"]],
					},
				]);
			}
			if (query.includes("histogram_quantile(0.95")) {
				return jsonResponse([{ metric: {}, values: [[END_TS, "0.123"]] }]);
			}
			if (query.includes("traefik_service_requests_bytes_total")) {
				return jsonResponse([{ metric: {}, values: [[END_TS, "512"]] }]);
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

		expect(fetchMock).toHaveBeenCalledTimes(12);
		expect(instantTimes).toEqual([String(END_TS), String(END_TS)]);
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
		expect(queries).toContain(
			`sum(increase(traefik_service_requests_bytes_total{service=~"^${SERVICE_ID}(@file)?$"}[1d]))`,
		);
		expect(queries).toContain(
			`sum(increase(traefik_service_responses_bytes_total{service=~"^${SERVICE_ID}(@file)?$"}[1d]))`,
		);
		expect(
			starts.every((start) => start === String(END_TS - 24 * 60 * 60 + 5 * 60)),
		).toBe(true);
		expect(stats.totalRequests).toBe(21);
		expect(stats.totalIngressBytes).toBe(460);
		expect(stats.totalEgressBytes).toBe(683051);
		expect(stats.statusCodes).toEqual(["2xx", "3xx", "4xx", "5xx"]);
		expect(stats.buckets).toHaveLength(288);
		expect(stats.windowEnd).toBe("2026-07-02T12:30:00.000Z");
		expect(stats.buckets[0]?.timestamp).toBe("2026-07-01T12:35:00.000Z");

		const lastBucket = stats.buckets.at(-1);
		expect(lastBucket).toMatchObject({
			totalRequests: 21,
			statuses: { "2xx": 5, "3xx": 1, "4xx": 4, "5xx": 11 },
			p95ResponseTimeMs: 123,
			ingressBytesPerSecond: 512,
			egressBytesPerSecond: 2048,
			cpuUsagePercent: 42,
		});
	});

	it("keeps service metrics available when traffic total queries fail", async () => {
		vi.stubEnv("VICTORIA_METRICS_URL", "http://victoria.test");
		vi.stubEnv("VICTORIA_METRICS_PRIVATE_URL", "");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				if (url.pathname === "/api/v1/query") {
					return new Response("Unavailable", { status: 503 });
				}
				return jsonResponse([]);
			}),
		);

		const stats = await queryServiceMetrics({
			serviceId: SERVICE_ID,
			range: "1h",
			now: new Date("2026-07-02T12:34:00Z"),
		});

		expect(stats.metricsEnabled).toBe(true);
		expect(stats.totalIngressBytes).toBeNull();
		expect(stats.totalEgressBytes).toBeNull();
		expect(stats.buckets).toHaveLength(60);
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

function instantJsonResponse(value: string) {
	return new Response(
		JSON.stringify({
			status: "success",
			data: { result: [{ metric: {}, value: [END_TS, value] }] },
		}),
	);
}
