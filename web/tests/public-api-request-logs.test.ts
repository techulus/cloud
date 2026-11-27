import { describe, expect, it } from "vitest";
import { publicRequestLog } from "@/lib/public-api-routes";
import type { StoredLog } from "@/lib/victoria-logs";

describe("public API request logs", () => {
	it("coerces VictoriaLogs string fields into numbers", () => {
		const log = {
			_msg: "POST /v1/items 201 12ms",
			_time: "2026-07-20T00:00:00Z",
			service_id: "service-1",
			method: "POST",
			path: "/v1/items",
			status: "201",
			duration_ms: "12.5",
			size: "321",
			client_ip: "192.0.2.10",
			host: "app.example.com",
		} as unknown as StoredLog;

		expect(publicRequestLog(log)).toEqual({
			method: "POST",
			path: "/v1/items",
			status: 201,
			durationMs: 12.5,
			size: 321,
			clientIp: "192.0.2.10",
			host: "app.example.com",
			timestamp: "2026-07-20T00:00:00Z",
		});
	});

	it("maps missing, empty, and non-numeric fields to null", () => {
		const log = {
			_msg: "",
			_time: "2026-07-20T00:00:00Z",
			service_id: "service-1",
			status: "",
			duration_ms: "abc",
		} as unknown as StoredLog;

		expect(publicRequestLog(log)).toMatchObject({
			method: null,
			path: null,
			status: null,
			durationMs: null,
			size: null,
			clientIp: null,
			host: null,
		});
	});
});
