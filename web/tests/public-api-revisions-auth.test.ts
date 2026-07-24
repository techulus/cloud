import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireApiKeyRole: vi.fn(async (request: Request) =>
		request.headers.get("x-api-key") === "tcl_secret"
			? {
					ok: true as const,
					session: {
						user: {
							id: "user-1",
							name: "Alice",
							email: "alice@example.com",
						},
						session: {
							id: "key-1",
							expiresAt: new Date("2027-01-01T00:00:00Z"),
						},
					},
				}
			: {
					ok: false as const,
					response: Response.json(
						{ message: "Unauthorized", code: "UNAUTHORIZED" },
						{ status: 401 },
					),
				},
	),
	requireRequestSession: vi.fn(async () => ({
		ok: false as const,
		response: Response.json(
			{ message: "Unauthorized", code: "UNAUTHORIZED" },
			{ status: 401 },
		),
	})),
	findNestedService: vi.fn(async () => ({ id: "service-1" })),
	queryServiceRevisionChangelog: vi.fn(async () => ({
		revisions: [
			{
				id: "revision-1",
				createdAt: "2026-07-21T00:00:00.000Z",
				actor: null,
				comparison: {
					kind: "changes" as const,
					changes: [
						{ field: "Image", from: "app:v1", to: "app:v2" },
						{ field: "Secret", from: "TOKEN", to: "TOKEN (updated)" },
					],
				},
				rollout: null,
			},
		],
		nextCursor: null,
	})),
}));

vi.mock("@/lib/api-auth", () => ({
	requireApiKeyRole: mocks.requireApiKeyRole,
	requireRequestSession: mocks.requireRequestSession,
}));

vi.mock("@/lib/public-api", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/public-api")>()),
	findNestedService: mocks.findNestedService,
}));

vi.mock("@/lib/service-revision-changelog", () => ({
	queryServiceRevisionChangelog: mocks.queryServiceRevisionChangelog,
}));

import { GET } from "@/app/api/v1/projects/[projectId]/environments/[environmentId]/services/[serviceId]/revisions/route";

it("lists public revisions with an API key without requiring a browser session", async () => {
	const response = await GET(
		new Request(
			"https://cloud.test/api/v1/projects/project-1/environments/environment-1/services/service-1/revisions",
			{ headers: { "x-api-key": "tcl_secret" } },
		),
		{
			params: Promise.resolve({
				projectId: "project-1",
				environmentId: "environment-1",
				serviceId: "service-1",
			}),
		},
	);

	if (!response) throw new Error("Expected a public API response");
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		revisions: [
			{
				id: "revision-1",
				createdAt: "2026-07-21T00:00:00.000Z",
				actor: null,
				comparison: {
					kind: "changes",
					changes: [{ field: "Image", from: "app:v1", to: "app:v2" }],
				},
				rollout: null,
			},
		],
		nextCursor: null,
	});
	expect(mocks.requireApiKeyRole).toHaveBeenCalledOnce();
	expect(mocks.requireRequestSession).not.toHaveBeenCalled();
});
