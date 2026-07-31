import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const selectResults: unknown[][] = [];
	function selectQuery(result: unknown[]) {
		const query = {
			from: vi.fn(() => query),
			leftJoin: vi.fn(() => query),
			orderBy: vi.fn(() => query),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return query;
	}

	return {
		selectResults,
		getSession: vi.fn(),
		db: {
			select: vi.fn(() => selectQuery(selectResults.shift() ?? [])),
		},
	};
});

vi.mock("next/headers", () => ({
	headers: async () => new Headers(),
}));
vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/auth", () => ({
	auth: { api: { getSession: mocks.getSession } },
}));

import { GET } from "@/app/api/navigation/route";

describe("navigation API", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectResults.length = 0;
	});

	it("rejects unauthenticated requests without querying navigation data", async () => {
		mocks.getSession.mockResolvedValue(null);

		const response = await GET();

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
		expect(mocks.db.select).not.toHaveBeenCalled();
	});

	it("returns dashboard and dynamic child pages for an authenticated session", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.selectResults.push(
			[
				{
					projectId: "project-1",
					projectName: "Acme",
					projectSlug: "acme",
					environmentId: "environment-1",
					environmentName: "production",
					serviceId: "service-1",
					serviceName: "API",
					serviceHostname: "api-production",
				},
			],
			[{ id: "server-1", name: "edge-01" }],
		);

		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.db.select).toHaveBeenCalledTimes(2);
		expect(body.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ href: "/dashboard" }),
				expect.objectContaining({
					href: "/dashboard/projects/acme/production/services/service-1/logs",
				}),
				expect.objectContaining({
					href: "/dashboard/servers/server-1/settings",
				}),
			]),
		);
	});
});
