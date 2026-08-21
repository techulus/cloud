import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const selectResults: unknown[][] = [];
	const updateResults: unknown[][] = [];
	function query(result: unknown[]) {
		const value = {
			from: vi.fn(() => value),
			innerJoin: vi.fn(() => value),
			where: vi.fn(() => value),
			limit: vi.fn(() => value),
			set: vi.fn(() => value),
			returning: vi.fn(() => value),
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
			then: (
				resolve: (rows: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return value;
	}
	return {
		selectResults,
		updateResults,
		db: {
			select: vi.fn(() => query(selectResults.shift() ?? [])),
			update: vi.fn(() => query(updateResults.shift() ?? [])),
		},
		decryptSecret: vi.fn(),
		notify: vi.fn(),
		reportBusinessFailure: vi.fn(),
		reportServerError: vi.fn(),
		ingestCronLog: vi.fn(),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: mocks.decryptSecret }));
vi.mock("@/lib/notifications", () => ({ notify: mocks.notify }));
vi.mock("@/lib/server-errors", () => ({
	reportBusinessFailure: mocks.reportBusinessFailure,
	reportServerError: mocks.reportServerError,
}));
vi.mock("@/lib/victoria-logs", () => ({
	ingestCronLog: mocks.ingestCronLog,
}));

import {
	cronEventId,
	executeServiceCron,
	latestDueOccurrence,
	nextOccurrenceAfter,
	parseCronUrl,
	performCronGet,
	validateCronTransport,
} from "@/lib/service-crons";

describe("service cron scheduling and requests", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectResults.length = 0;
		mocks.updateResults.length = 0;
		mocks.notify.mockResolvedValue(undefined);
		mocks.ingestCronLog.mockResolvedValue(undefined);
	});

	it("returns the first UTC occurrence strictly after the supplied instant", () => {
		expect(
			nextOccurrenceAfter(
				"0 5 * * *",
				new Date("2026-08-06T05:00:00.000Z"),
			).toISOString(),
		).toBe("2026-08-07T05:00:00.000Z");
		expect(
			nextOccurrenceAfter(
				"30 23 * * *",
				new Date("2026-08-06T22:00:00-04:00"),
			).toISOString(),
		).toBe("2026-08-07T23:30:00.000Z");
	});

	it("coalesces missed intervals to the latest UTC occurrence", () => {
		const due = latestDueOccurrence(
			"* * * * *",
			new Date("2000-01-01Z"),
			new Date("2026-08-06T10:05:30Z"),
		);
		expect(due?.toISOString()).toBe("2026-08-06T10:05:00.000Z");
		expect(latestDueOccurrence("* * * * *", due!, due!)).toBeNull();
		expect(cronEventId("cron-1", due!)).toBe(cronEventId("cron-1", due!));
	});

	it.each([
		["ftp://example.com", "/job"],
		["https://user:pass@example.com", "/job"],
		["https://example.com?x=1", "/job"],
		["https://example.com#x", "/job"],
		["https://example.com", "//host/job"],
		["https://example.com", "/a/%2e%2e/job"],
	])("rejects unsafe URL %s %s", (base, path) =>
		expect(() => parseCronUrl(base, path)).toThrow(),
	);

	it("joins a safe path while preserving the origin hostname", () => {
		expect(parseCronUrl("https://example.com", "/jobs/nightly").href).toBe(
			"https://example.com/jobs/nightly",
		);
	});

	it("rejects a secret over cleartext HTTP", () => {
		expect(() =>
			validateCronTransport(new URL("http://example.com/job"), "not-logged"),
		).toThrow("requires HTTPS");
		expect(() =>
			validateCronTransport(new URL("http://example.com/job")),
		).not.toThrow();
	});

	it("performs a GET without connection pooling", async () => {
		let options!: RequestOptions;
		const request = fakeRequest(204, (received) => {
			options = received;
		});
		await expect(
			performCronGet(
				new URL("https://example.com/job"),
				undefined,
				1_000,
				request,
			),
		).resolves.toEqual({
			status: "succeeded",
			statusCode: 204,
			error: null,
		});
		expect(options).toMatchObject({ method: "GET", agent: false });
		expect(options.lookup).toBeUndefined();
		expect(request).toHaveBeenCalledTimes(1);
	});

	it.each([302, 404])(
		"classifies HTTP %s at headers without retaining a body",
		async (code) => {
			let destroyed = false;
			const request = fakeRequest(code, undefined, () => {
				destroyed = true;
			});
			await expect(
				performCronGet(
					new URL("https://example.com/job"),
					undefined,
					1_000,
					request,
				),
			).resolves.toMatchObject({ status: "failed", statusCode: code });
			expect(destroyed).toBe(true);
			expect(request).toHaveBeenCalledTimes(1);
		},
	);

	it("settles once when the absolute request timeout expires", async () => {
		vi.useFakeTimers();
		try {
			const request = vi.fn(() => {
				const req = new EventEmitter() as ClientRequest;
				req.end = vi.fn(() => req) as unknown as ClientRequest["end"];
				req.destroy = vi.fn(() => req) as ClientRequest["destroy"];
				return req;
			}) as unknown as typeof import("node:http").request;
			const result = performCronGet(
				new URL("https://example.com/job"),
				undefined,
				25,
				request,
			);
			await vi.advanceTimersByTimeAsync(25);
			await expect(result).resolves.toEqual({
				status: "failed",
				statusCode: null,
				error: "Cron request timed out",
			});
			expect(request).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports a claimed failed execution without URL or secret context", async () => {
		const scheduledFor = new Date("2026-08-06T10:05:00Z");
		mocks.selectResults.push(
			[
				{
					cron: {
						schedule: "* * * * *",
						path: "/private/job",
					},
					serviceId: "service-1",
				},
			],
			[
				{
					key: "CRON_BASE_URL",
					encryptedValue: "encrypted-sensitive-value",
				},
			],
		);
		mocks.updateResults.push([{ id: "cron-1" }], []);
		mocks.decryptSecret.mockRejectedValue(new Error("decrypt failed"));

		await expect(
			executeServiceCron("cron-1", "* * * * *", scheduledFor, "scheduled"),
		).resolves.toMatchObject({ stale: false, status: "failed" });

		expect(mocks.reportBusinessFailure).toHaveBeenCalledWith(
			"service-cron.failed",
			{
				occurrenceId: cronEventId("cron-1", scheduledFor),
				reason: "request_failed",
				tags: {
					cronId: "cron-1",
					serviceId: "service-1",
					source: "scheduled",
				},
				extra: { statusCode: null },
			},
		);
		const captured = JSON.stringify(mocks.reportBusinessFailure.mock.calls);
		expect(captured).not.toContain("/private/job");
		expect(captured).not.toContain("encrypted-sensitive-value");
	});
});

function fakeRequest(
	statusCode: number,
	onOptions?: (options: RequestOptions) => void,
	onResponseDestroy?: () => void,
) {
	return vi.fn(
		(
			_url: URL,
			options: RequestOptions,
			callback: (response: IncomingMessage) => void,
		) => {
			onOptions?.(options);
			const req = new EventEmitter() as ClientRequest;
			req.end = vi.fn(() => {
				const response = new EventEmitter() as IncomingMessage;
				response.statusCode = statusCode;
				response.destroy = vi.fn(() => {
					onResponseDestroy?.();
					return response;
				}) as IncomingMessage["destroy"];
				callback(response);
				return req;
			}) as unknown as ClientRequest["end"];
			req.destroy = vi.fn(() => req) as ClientRequest["destroy"];
			return req;
		},
	) as unknown as typeof import("node:http").request;
}
