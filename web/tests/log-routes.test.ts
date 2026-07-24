import { afterEach, describe, expect, it, vi } from "vitest";

describe("log routes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		vi.doUnmock("next/headers");
		vi.doUnmock("@/lib/auth");
		vi.doUnmock("@/lib/victoria-logs");
	});

	it.each([
		{
			name: "an oversized search",
			params: { q: "x".repeat(201) },
			message: "Search must be 200 characters or fewer",
		},
		{
			name: "an injected cursor",
			params: {
				before: "2026-07-10T01:02:03Z OR service_id:service-2",
			},
			message: "Invalid log cursor",
		},
		{
			name: "a non-numeric limit",
			params: { limit: "abc" },
			message: "Invalid log limit",
		},
		{
			name: "an unsupported range",
			params: { range: "30d" },
			message: "Invalid log range",
		},
	])("rejects $name before querying VictoriaLogs", async ({
		params,
		message,
	}) => {
		const { GET, queryLogsByService } = await loadServiceLogsRoute();
		const url = new URL("http://localhost/api/services/service-1/logs");
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}

		const response = await GET(new Request(url), {
			params: Promise.resolve({ id: "service-1" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ message });
		expect(queryLogsByService).not.toHaveBeenCalled();
	});

	it("returns a gateway error when VictoriaLogs fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const queryLogsByService = vi.fn(async () => {
			throw new Error("VictoriaLogs unavailable");
		});
		const { GET } = await loadServiceLogsRoute(queryLogsByService);

		const response = await GET(
			new Request("http://localhost/api/services/service-1/logs"),
			{ params: Promise.resolve({ id: "service-1" }) },
		);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			message: "Failed to query service logs",
		});
	});

	it("passes a validated after cursor to the deployment query", async () => {
		const { GET, queryLogsByDeployment } = await loadDeploymentLogsRoute();
		const cursor = "2026-07-10T01:02:03Z";
		const response = await GET(
			new Request(
				`http://localhost/api/deployments/deployment-1/logs?after=${cursor}`,
			),
			{ params: Promise.resolve({ id: "deployment-1" }) },
		);

		expect(response.status).toBe(200);
		expect(queryLogsByDeployment).toHaveBeenCalledWith(
			"deployment-1",
			100,
			cursor,
		);
	});

	it("rejects an invalid deployment cursor before querying logs", async () => {
		const { GET, queryLogsByDeployment } = await loadDeploymentLogsRoute();
		const url = new URL("http://localhost/api/deployments/deployment-1/logs");
		url.searchParams.set("after", "2026-07-10T01:02:03Z | stats count()");

		const response = await GET(new Request(url), {
			params: Promise.resolve({ id: "deployment-1" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ message: "Invalid log cursor" });
		expect(queryLogsByDeployment).not.toHaveBeenCalled();
	});

	it("returns a gateway error when deployment logs fail", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const queryLogsByDeployment = vi.fn(async () => {
			throw new Error("VictoriaLogs unavailable");
		});
		const { GET } = await loadDeploymentLogsRoute(queryLogsByDeployment);

		const response = await GET(
			new Request("http://localhost/api/deployments/deployment-1/logs"),
			{ params: Promise.resolve({ id: "deployment-1" }) },
		);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			message: "Failed to query deployment logs",
		});
	});
});

function mockAuthenticatedSession() {
	vi.resetModules();
	vi.doMock("next/headers", () => ({
		headers: async () => new Headers(),
	}));
	vi.doMock("@/lib/auth", () => ({
		auth: {
			api: {
				getSession: async () => ({ user: { id: "user-1" } }),
			},
		},
	}));
}

async function loadServiceLogsRoute(
	queryLogsByService = vi.fn(async () => ({ logs: [], hasMore: false })),
) {
	mockAuthenticatedSession();
	vi.doMock("@/lib/victoria-logs", () => ({
		isLoggingEnabled: () => true,
		queryLogsByService,
	}));

	const { GET } = await import("@/app/api/services/[id]/logs/route");
	return { GET, queryLogsByService };
}

async function loadDeploymentLogsRoute(
	queryLogsByDeployment = vi.fn(async () => ({ logs: [], hasMore: false })),
) {
	mockAuthenticatedSession();
	vi.doMock("@/lib/victoria-logs", () => ({
		isLoggingEnabled: () => true,
		queryLogsByDeployment,
	}));

	const { GET } = await import("@/app/api/deployments/[id]/logs/route");
	return { GET, queryLogsByDeployment };
}
