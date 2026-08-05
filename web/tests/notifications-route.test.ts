import { inspect } from "node:util";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const selectResults: unknown[][] = [];
	const updateResults: unknown[][] = [];
	const whereValues: unknown[] = [];
	function selectQuery(result: unknown[]) {
		const query = {
			from: vi.fn(() => query),
			where: vi.fn((value: unknown) => {
				whereValues.push(value);
				return query;
			}),
			orderBy: vi.fn(() => query),
			limit: vi.fn(() => query),
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
			then: (resolve: (value: unknown[]) => unknown) =>
				Promise.resolve(result).then(resolve),
		};
		return query;
	}
	function updateQuery(result: unknown[]) {
		const query = {
			set: vi.fn(() => query),
			where: vi.fn((value: unknown) => {
				whereValues.push(value);
				return query;
			}),
			returning: vi.fn(() => query),
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
			then: (resolve: (value: unknown[]) => unknown) =>
				Promise.resolve(result).then(resolve),
		};
		return query;
	}
	return {
		selectResults,
		updateResults,
		whereValues,
		getSession: vi.fn(),
		db: {
			select: vi.fn(() => selectQuery(selectResults.shift() ?? [])),
			update: vi.fn(() => updateQuery(updateResults.shift() ?? [])),
		},
	};
});

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/auth", () => ({
	auth: { api: { getSession: mocks.getSession } },
}));

import { POST } from "@/app/api/notifications/read/route";
import { GET } from "@/app/api/notifications/route";

const get = (cursor = "") =>
	GET(
		new Request(`http://localhost/api/notifications${cursor}`) as NextRequest,
	);
const post = (body: unknown) =>
	POST(
		new Request("http://localhost/api/notifications/read", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	);

describe("notifications API", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectResults.length = 0;
		mocks.updateResults.length = 0;
		mocks.whereValues.length = 0;
	});

	it("rejects unauthenticated list and read requests", async () => {
		mocks.getSession.mockResolvedValue(null);
		expect((await get()).status).toBe(401);
		expect((await post({ markAll: true })).status).toBe(401);
		expect(mocks.db.select).not.toHaveBeenCalled();
		expect(mocks.db.update).not.toHaveBeenCalled();
	});

	it("returns a user-scoped bounded page and unread count", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
		const rows = Array.from({ length: 21 }, (_, index) => ({
			id: `notification-${String(21 - index).padStart(2, "0")}`,
			kind: "server.offline",
			title: "Server offline",
			body: "Edge is offline",
			href: "/dashboard/servers/server-1",
			readAt: null,
			createdAt: new Date(
				`2026-08-01T00:${String(21 - index).padStart(2, "0")}:00Z`,
			),
		}));
		mocks.selectResults.push(rows, [{ count: 7 }]);

		const response = await get();
		const body = await response.json();

		expect(body.notifications).toHaveLength(20);
		expect(body.unreadCount).toBe(7);
		expect(body.nextCursor).toEqual(expect.any(String));
		expect(mocks.whereValues).toHaveLength(2);
		expect(inspect(mocks.whereValues, { depth: null })).toContain("user-1");
	});

	it("marks one notification read while retaining the authenticated user scope", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.updateResults.push([{ id: "notification-1" }]);

		const response = await post({ id: "notification-1" });

		expect(await response.json()).toEqual({ updated: 1 });
		const condition = inspect(mocks.whereValues[0], { depth: null });
		expect(condition).toContain("user-1");
		expect(condition).toContain("notification-1");
	});

	it("marks all unread notifications for only the authenticated user", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "user-2" } });
		mocks.updateResults.push([
			{ id: "notification-2" },
			{ id: "notification-3" },
		]);

		const response = await post({ markAll: true });

		expect(await response.json()).toEqual({ updated: 2 });
		const condition = inspect(mocks.whereValues[0], { depth: null });
		expect(condition).toContain("user-2");
		expect(condition).not.toContain("notification-1");
	});

	it("cannot update another user's notification", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.updateResults.push([]);

		const response = await post({ id: "user-2-notification" });

		expect(await response.json()).toEqual({ updated: 0 });
		expect(inspect(mocks.whereValues[0], { depth: null })).toContain("user-1");
	});
});
