import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LOG_TIME_RANGE,
	escapeLogRegex,
	isLogCursor,
	MAX_LOG_SEARCH_LENGTH,
	normalizeLogCursor,
	normalizeLogSearch,
	parseLogLimit,
	parseLogListParams,
	splitLogSearchMatches,
} from "@/lib/log-query";

describe("VictoriaLogs queries", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("validates log search and time range inputs", () => {
		expect(DEFAULT_LOG_TIME_RANGE).toBe("24h");
		expect(normalizeLogSearch("  database error  ")).toBe("database error");
		expect(normalizeLogSearch("   ")).toBeUndefined();
		expect(() =>
			normalizeLogSearch("x".repeat(MAX_LOG_SEARCH_LENGTH + 1)),
		).toThrow(`Search must be ${MAX_LOG_SEARCH_LENGTH} characters or fewer`);

		expect(isLogCursor("2026-07-10T01:02:03Z")).toBe(true);
		expect(isLogCursor("2026-07-10T01:02:03.123456789Z")).toBe(true);
		expect(isLogCursor("2026-07-10T01:02:03+10:00")).toBe(true);
		expect(isLogCursor("2026-02-29T01:02:03Z")).toBe(false);
		expect(isLogCursor("2024-02-29T01:02:03Z")).toBe(true);
		expect(isLogCursor("2026-07-10T01:02:03Z OR service_id:service-2")).toBe(
			false,
		);
		expect(isLogCursor("2026-07-10T01:02:03Z | stats count()")).toBe(false);
		expect(normalizeLogCursor(" 2026-07-10T01:02:03Z ")).toBe(
			"2026-07-10T01:02:03Z",
		);
		expect(() =>
			normalizeLogCursor("2026-07-10T01:02:03Z | stats count()"),
		).toThrow("Invalid log cursor");

		expect(parseLogLimit(null, 100)).toBe(100);
		expect(parseLogLimit("500", 100)).toBe(500);
		expect(parseLogLimit("1001", 100)).toBe(1000);
		expect(() => parseLogLimit("0", 100)).toThrow("Invalid log limit");
		expect(() => parseLogLimit("abc", 100)).toThrow("Invalid log limit");

		expect(
			parseLogListParams(
				new URLSearchParams({
					q: " database error ",
					before: "2026-07-10T01:02:03Z",
					limit: "500",
					range: "7d",
				}),
				100,
			),
		).toEqual({
			search: "database error",
			before: "2026-07-10T01:02:03Z",
			limit: 500,
			range: "7d",
		});
		expect(parseLogListParams(new URLSearchParams(), 100).range).toBe("24h");
		expect(() =>
			parseLogListParams(new URLSearchParams({ range: "30d" }), 100),
		).toThrow("Invalid log range");

		expect(splitLogSearchMatches("error and ERROR", "error")).toEqual([
			{ text: "", isMatch: false },
			{ text: "error", isMatch: true },
			{ text: " and ", isMatch: false },
			{ text: "ERROR", isMatch: true },
			{ text: "", isMatch: false },
		]);
	});

	it("escapes search text as a literal case-insensitive regex", async () => {
		const { formatLogSqlSearchFilter } = await loadVictoriaLogs();
		const search = 'error ") OR log_type:build .* [db] \\path';
		const filter = formatLogSqlSearchFilter(search);

		expect(filter).toBeDefined();
		const encodedPattern = filter?.slice("_msg:~".length) || "";
		expect(JSON.parse(encodedPattern)).toBe(`(?i)${escapeLogRegex(search)}`);
	});

	it("rejects service-log cursors before issuing a LogsQL request", async () => {
		const { queryLogsByService } = await loadVictoriaLogs();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			queryLogsByService({
				serviceId: "service-1",
				limit: 100,
				before: "2026-07-10T01:02:03Z OR service_id:service-2",
			}),
		).rejects.toThrow("Invalid log cursor");
		await expect(
			queryLogsByService({
				serviceId: "service-1",
				limit: 100,
				after: "2026-07-10T01:02:03Z | stats count()",
			}),
		).rejects.toThrow("Invalid log cursor");
		expect(fetchMock).not.toHaveBeenCalled();
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

	it("returns an initial public tail in chronological tuple order", async () => {
		const { queryPublicServiceLogs } = await loadVictoriaLogs();
		const urls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				urls.push(new URL(String(input)));
				return jsonLinesResponse([
					storedLogWithId("2026-07-10T00:00:00Z", "extra", eventId("a")),
					storedLogWithId("2026-07-10T00:00:01Z", "first", eventId("b")),
					storedLogWithId("2026-07-10T00:00:02Z", "second", eventId("c")),
				]);
			}),
		);

		const result = await queryPublicServiceLogs({
			serviceId: "service-1",
			limit: 2,
			logType: "container",
		});

		expect(result.logs.map((log) => log._msg)).toEqual(["first", "second"]);
		expect(result.hasMore).toBe(false);
		const url = urls[0];
		expect(url?.searchParams.has("limit")).toBe(false);
		expect(url?.searchParams.get("timeout")).toBe("4s");
		expect(url?.searchParams.get("query")).toContain(
			"| first 3 by (_time desc, event_id desc) | sort by (_time, event_id)",
		);
		expect(url?.searchParams.get("query")).toContain("_time:24h");
	});

	it("pages equal-timestamp public logs by event ID without skips", async () => {
		const { queryPublicServiceLogs } = await loadVictoriaLogs();
		const queries: string[] = [];
		const logs = [
			storedLogWithId("2026-07-10T00:00:00Z", "a", eventId("a")),
			storedLogWithId("2026-07-10T00:00:00Z", "b", eventId("b")),
			storedLogWithId("2026-07-10T00:00:00Z", "c", eventId("c")),
		];
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async (input: string | URL | Request) => {
				queries.push(new URL(String(input)).searchParams.get("query") || "");
				return jsonLinesResponse(logs);
			})
			.mockImplementationOnce(async (input: string | URL | Request) => {
				queries.push(new URL(String(input)).searchParams.get("query") || "");
				return jsonLinesResponse([logs[2]]);
			});
		vi.stubGlobal("fetch", fetchMock);

		const first = await queryPublicServiceLogs({
			serviceId: "service-1",
			limit: 2,
			logType: "container",
			cursor: { time: "2026-07-09T23:59:59Z", eventId: "" },
		});
		const second = await queryPublicServiceLogs({
			serviceId: "service-1",
			limit: 2,
			logType: "container",
			cursor: {
				time: first.logs[1]._time,
				eventId: first.logs[1].event_id ?? "",
			},
		});

		expect(first.logs.map((log) => log._msg)).toEqual(["a", "b"]);
		expect(first.hasMore).toBe(true);
		expect(second.logs.map((log) => log._msg)).toEqual(["c"]);
		expect(second.hasMore).toBe(false);
		expect(queries[0]).toContain("| first 3 by (_time, event_id)");
		expect(queries[0]).toContain("_time:>=2026-07-09T23:59:59Z");
		expect(queries[1]).toContain(
			`_time:>=2026-07-10T00:00:00Z _time:<=2026-07-10T00:00:00Z event_id:>"${eventId("b")}"`,
		);
	});

	it("fails loudly rather than skipping unidentified logs while following", async () => {
		const { queryPublicServiceLogs, ServiceLogCursorUnavailableError } =
			await loadVictoriaLogs();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonLinesResponse([
					storedLog("2026-07-10T00:00:00Z", "legacy agent log"),
				]),
			),
		);

		await expect(
			queryPublicServiceLogs({
				serviceId: "service-1",
				limit: 2,
				logType: "container",
				cursor: {
					time: "2026-07-09T23:59:59Z",
					eventId: eventId("a"),
				},
			}),
		).rejects.toBeInstanceOf(ServiceLogCursorUnavailableError);
	});

	it("propagates caller cancellation to the VictoriaLogs request", async () => {
		const { queryPublicServiceLogs } = await loadVictoriaLogs();
		const controller = new AbortController();
		let providerSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((_input: string | URL | Request, init?: RequestInit) => {
				providerSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					providerSignal?.addEventListener(
						"abort",
						() => reject(new DOMException("Aborted", "AbortError")),
						{ once: true },
					);
				});
			}),
		);

		const result = queryPublicServiceLogs({
			serviceId: "service-1",
			limit: 2,
			logType: "container",
			signal: controller.signal,
		});
		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(providerSignal?.aborted).toBe(true);
	});

	it("queries deployment logs after the supplied cursor", async () => {
		const { queryLogsByDeployment } = await loadVictoriaLogs();
		let query = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				query = new URL(String(input)).searchParams.get("query") || "";
				return jsonLinesResponse([]);
			}),
		);

		await queryLogsByDeployment("deployment-1", 100, "2026-07-10T01:02:03Z");

		expect(query).toContain("deployment_id:deployment-1");
		expect(query).toContain("_time:>2026-07-10T01:02:03Z");
		expect(query).not.toContain("_time:<2026-07-10T01:02:03Z");
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

		expect(query).toContain(
			'(_msg:~"(?i)10\\\\.0\\\\.0\\\\.1" OR path:~"(?i)10\\\\.0\\\\.0\\\\.1" OR method:~"(?i)10\\\\.0\\\\.0\\\\.1" OR status:~"(?i)10\\\\.0\\\\.0\\\\.1" OR client_ip:~"(?i)10\\\\.0\\\\.0\\\\.1")',
		);
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

function eventId(suffix: string) {
	return `e${"1".padStart(19, "0")}${suffix.repeat(26)}`;
}

function storedLogWithId(time: string, message: string, id: string) {
	return { ...storedLog(time, message), event_id: id };
}

function jsonLinesResponse(logs: unknown[]) {
	return new Response(logs.map((log) => JSON.stringify(log)).join("\n"), {
		status: 200,
	});
}
