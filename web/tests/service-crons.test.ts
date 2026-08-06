import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
	cronEventId,
	isGlobalAddress,
	latestDueOccurrence,
	nextOccurrenceAfter,
	parseCronUrl,
	performCronGet,
	resolvePublicAddresses,
	validateCronTransport,
} from "@/lib/service-crons";

describe("service cron scheduling and SSRF validation", () => {
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

	it.each([
		"10.0.0.1",
		"127.0.0.1",
		"169.254.1.1",
		"192.0.2.1",
		"192.88.99.1",
		"::1",
		"fc00::1",
		"fe80::1",
		"2001::1",
		"2001:db8::1",
		"3fff::1",
		"::ffff:10.0.0.1",
	])("rejects non-global address %s", (address) =>
		expect(isGlobalAddress(address)).toBe(false),
	);

	it("rejects mixed DNS results", async () => {
		const lookup = vi.fn(async () => [
			{ address: "8.8.8.8", family: 4 as const },
			{ address: "10.0.0.1", family: 4 as const },
		]);
		await expect(resolvePublicAddresses("example.com", lookup)).rejects.toThrow(
			"not public",
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

	it.each([false, true])(
		"pins lookup for all=%s without pooling",
		async (all) => {
			let options!: RequestOptions & { autoSelectFamily?: boolean };
			const request = fakeRequest(204, (received) => {
				options = received;
			});
			const result = performCronGet(
				new URL("https://example.com/job"),
				[
					{ address: "8.8.8.8", family: 4 },
					{ address: "2001:4860:4860::8888", family: 6 },
				],
				undefined,
				1_000,
				request,
			);
			const callback = vi.fn();
			options.lookup!("example.com", { all }, callback);
			if (all)
				expect(callback).toHaveBeenCalledWith(null, [
					{ address: "8.8.8.8", family: 4 },
					{ address: "2001:4860:4860::8888", family: 6 },
				]);
			else expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
			expect(options).toMatchObject({
				agent: false,
				autoSelectFamily: false,
				servername: "example.com",
			});
			expect(await result).toEqual({
				status: "succeeded",
				statusCode: 204,
				error: null,
			});
			expect(request).toHaveBeenCalledTimes(1);
		},
	);

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
					[{ address: "8.8.8.8", family: 4 }],
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
				[{ address: "8.8.8.8", family: 4 }],
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
});

function fakeRequest(
	statusCode: number,
	onOptions?: (
		options: RequestOptions & { autoSelectFamily?: boolean },
	) => void,
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
