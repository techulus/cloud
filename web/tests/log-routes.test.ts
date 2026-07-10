import { afterEach, describe, expect, it, vi } from "vitest";

describe("log routes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		vi.doUnmock("next/headers");
		vi.doUnmock("@/lib/api-auth");
		vi.doUnmock("@/lib/auth");
		vi.doUnmock("@/lib/cli-service");
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

	it("rejects an injected manifest cursor before resolving the service", async () => {
		vi.resetModules();
		const getManifestStatus = vi.fn();
		const queryLogsByService = vi.fn();
		vi.doMock("@/lib/api-auth", () => ({
			requireRequestRole: async () => ({ ok: true }),
		}));
		vi.doMock("@/lib/cli-service", () => ({ getManifestStatus }));
		vi.doMock("@/lib/victoria-logs", () => ({
			isLoggingEnabled: () => true,
			queryLogsByService,
		}));
		const { GET } = await import("@/app/api/v1/manifest/logs/route");
		const url = new URL("http://localhost/api/v1/manifest/logs");
		url.searchParams.set("project", "project-1");
		url.searchParams.set("environment", "production");
		url.searchParams.set("service", "web");
		url.searchParams.set("after", "2026-07-10T01:02:03Z | stats count()");

		const response = await GET(new Request(url));

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Invalid log cursor" });
		expect(getManifestStatus).not.toHaveBeenCalled();
		expect(queryLogsByService).not.toHaveBeenCalled();
	});
});

async function loadServiceLogsRoute(
	queryLogsByService = vi.fn(async () => ({ logs: [], hasMore: false })),
) {
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
	vi.doMock("@/lib/victoria-logs", () => ({
		isLoggingEnabled: () => true,
		queryLogsByService,
	}));

	const { GET } = await import("@/app/api/services/[id]/logs/route");
	return { GET, queryLogsByService };
}
