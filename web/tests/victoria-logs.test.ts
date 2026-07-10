import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LOG_TIME_RANGE,
	isLogTimeRange,
	MAX_LOG_SEARCH_LENGTH,
	normalizeLogSearch,
} from "@/lib/log-query";

describe("VictoriaLogs queries", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("validates log search and time range inputs", () => {
		expect(DEFAULT_LOG_TIME_RANGE).toBe("24h");
		expect(isLogTimeRange("1h")).toBe(true);
		expect(isLogTimeRange("7d")).toBe(true);
		expect(isLogTimeRange("30d")).toBe(false);
		expect(normalizeLogSearch("  database error  ")).toBe("database error");
		expect(normalizeLogSearch("   ")).toBeUndefined();
		expect(() =>
			normalizeLogSearch("x".repeat(MAX_LOG_SEARCH_LENGTH + 1)),
		).toThrow(`Search must be ${MAX_LOG_SEARCH_LENGTH} characters or fewer`);
	});

	it("escapes search text as a literal case-insensitive regex", async () => {
		const { formatLogSqlSearchFilter } = await loadVictoriaLogs();
		const search = 'error ") OR log_type:build .* [db] \\path';
		const filter = formatLogSqlSearchFilter(search);

		expect(filter).toBeDefined();
		const encodedPattern = filter?.slice("_msg:~".length) || "";
		expect(JSON.parse(encodedPattern)).toBe(
			`(?i)${search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
		);
	});

	it("searches service logs before applying the result limit and range", async () => {
		const { queryLogsByService } = await loadVictoriaLogs();
		const urls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				urls.push(new URL(String(input)));
				return jsonLinesResponse([
					storedLog("2026-07-10T01:00:00Z", "first match"),
					storedLog("2026-07-10T00:00:00Z", "older match"),
				]);
			}),
		);

		const result = await queryLogsByService({
			serviceId: "service-1",
			limit: 1,
			before: "2026-07-10T02:00:00Z",
			logType: "container",
			search: "first match",
			range: "24h",
		});

		expect(result.logs).toHaveLength(1);
		expect(result.hasMore).toBe(true);
		const url = urls[0];
		expect(url?.searchParams.get("limit")).toBe("2");
		const query = url?.searchParams.get("query") || "";
		expect(query).toContain("service_id:service-1");
		expect(query).toContain("_time:24h");
		expect(query).toContain("_time:<2026-07-10T02:00:00Z");
		expect(query).toContain('_msg:~"(?i)first match"');
		expect(query.indexOf('_msg:~"(?i)first match"')).toBeLessThan(
			query.indexOf("| sort"),
		);
	});

	it("searches every field exposed by the request-log search box", async () => {
		const { queryLogsByService } = await loadVictoriaLogs();
		let query = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				query = new URL(String(input)).searchParams.get("query") || "";
				return jsonLinesResponse([]);
			}),
		);

		await queryLogsByService({
			serviceId: "service-1",
			limit: 500,
			logType: "http",
			search: "10.0.0.1",
			range: "6h",
		});

		for (const field of ["_msg", "path", "method", "status", "client_ip"]) {
			expect(query).toContain(`${field}:~"(?i)10\\\\.0\\\\.0\\\\.1"`);
		}
		expect(query).toContain(" OR ");
		expect(query).toContain("_time:6h");
	});

	it("applies search to server, build, and rollout log queries", async () => {
		const { queryLogsByBuild, queryLogsByRollout, queryLogsByServer } =
			await loadVictoriaLogs();
		const queries: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				queries.push(new URL(String(input)).searchParams.get("query") || "");
				return jsonLinesResponse([]);
			}),
		);

		await queryLogsByServer({
			serverId: "server-1",
			search: "connection lost",
			range: "7d",
		});
		await queryLogsByBuild("build-1", { search: "connection lost" });
		await queryLogsByRollout("rollout-1", { search: "connection lost" });

		expect(queries[0]).toContain("server_id:server-1");
		expect(queries[0]).toContain("_time:7d");
		expect(queries[1]).toContain("build_id:build-1");
		expect(queries[2]).toContain("rollout_id:rollout-1");
		for (const query of queries) {
			expect(query).toContain('_msg:~"(?i)connection lost"');
		}
	});
});

async function loadVictoriaLogs() {
	vi.resetModules();
	vi.stubEnv("VICTORIA_LOGS_URL", "http://victoria.test");
	vi.stubEnv("VICTORIA_LOGS_PRIVATE_URL", "");
	return import("@/lib/victoria-logs");
}

function storedLog(time: string, message: string) {
	return {
		_msg: message,
		_time: time,
		service_id: "service-1",
		log_type: "container",
	};
}

function jsonLinesResponse(logs: unknown[]) {
	return new Response(logs.map((log) => JSON.stringify(log)).join("\n"), {
		status: 200,
	});
}
