import { describe, expect, it, vi } from "vitest";
import {
	decodeServiceLogCursor,
	encodeServiceLogCursor,
	longPollLogs,
	nextServiceLogCursor,
} from "@/lib/public-api-routes";

describe("public API log long polling", () => {
	it("returns as soon as records appear", async () => {
		vi.useFakeTimers();
		const query = vi
			.fn()
			.mockResolvedValueOnce({ logs: [], hasMore: false })
			.mockResolvedValueOnce({ logs: [{ message: "ready" }], hasMore: false });
		const resultPromise = longPollLogs(query, {
			waitMs: 10_000,
			intervalMs: 100,
		});
		await vi.advanceTimersByTimeAsync(100);
		await expect(resultPromise).resolves.toEqual({
			logs: [{ message: "ready" }],
			hasMore: false,
		});
		expect(query).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("returns the last empty result at the timeout without an extra query", async () => {
		vi.useFakeTimers();
		const empty = { logs: [], hasMore: false, marker: "initial" };
		const query = vi.fn().mockResolvedValue(empty);
		const resultPromise = longPollLogs(query, {
			waitMs: 250,
			intervalMs: 100,
		});

		await vi.advanceTimersByTimeAsync(250);

		await expect(resultPromise).resolves.toBe(empty);
		expect(query).toHaveBeenCalledTimes(3);
		vi.useRealTimers();
	});

	it("does not query when the request is already aborted", async () => {
		const controller = new AbortController();
		const query = vi.fn().mockResolvedValue({ logs: [], hasMore: false });
		controller.abort(new DOMException("Aborted", "AbortError"));
		const resultPromise = longPollLogs(query, {
			waitMs: 10_000,
			signal: controller.signal,
		});
		await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });
		expect(query).not.toHaveBeenCalled();
	});

	it("round-trips an opaque tuple cursor and rejects malformed values", () => {
		const value = {
			v: 1 as const,
			t: "2026-07-20T12:34:56.123456789Z",
			e: `e${"1784546100123456789"}${"a".repeat(26)}`,
		};
		const cursor = encodeServiceLogCursor(value);

		expect(decodeServiceLogCursor(cursor)).toEqual(value);
		for (const invalid of [
			"not+base64url",
			Buffer.from(
				JSON.stringify({ ...value, t: "2026-02-31T00:00:00Z" }),
			).toString("base64url"),
			Buffer.from(
				JSON.stringify({ ...value, e: "uuid-is-not-sortable" }),
			).toString("base64url"),
		]) {
			expect(decodeServiceLogCursor(invalid)).toBeNull();
		}
	});

	it("anchors an unidentified initial page to its last log timestamp", () => {
		const timestamp = "2026-07-20T12:34:56.123456789Z";
		const cursor = nextServiceLogCursor(
			[
				{
					_msg: "legacy agent log",
					_time: timestamp,
					service_id: "service-1",
				},
			],
			null,
		);

		expect(decodeServiceLogCursor(cursor)).toEqual({
			v: 1,
			t: timestamp,
			e: "",
		});
	});
});
