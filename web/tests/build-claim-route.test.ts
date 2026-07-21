import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const selectResults: unknown[][] = [];
	const updateResults: unknown[][] = [];
	const updateSets: Array<Record<string, unknown>> = [];
	function selectQuery(result: unknown[]) {
		const query = {
			from: vi.fn(() => query),
			where: vi.fn(() => query),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return query;
	}
	function updateQuery(result: unknown[]) {
		const query = {
			set: vi.fn((value: Record<string, unknown>) => {
				updateSets.push(value);
				return query;
			}),
			where: vi.fn(() => query),
			returning: vi.fn(() => query),
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
		updateResults,
		updateSets,
		db: {
			select: vi.fn(() => selectQuery(selectResults.shift() ?? [])),
			update: vi.fn(() => updateQuery(updateResults.shift() ?? [])),
		},
		verifyAgentRequest: vi.fn(),
		getSetting: vi.fn(),
		send: vi.fn(),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/db/queries", () => ({ getSetting: mocks.getSetting }));
vi.mock("@/lib/agent-auth", () => ({
	verifyAgentRequest: mocks.verifyAgentRequest,
}));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: mocks.send } }));

import { POST } from "@/app/api/v1/agent/builds/[id]/route";

const build = {
	id: "build-amd64",
	serviceId: "service-1",
	serviceRevisionId: "revision-1",
	buildGroupId: "group-1",
	targetPlatform: "linux/amd64",
	commitSha: "0123456789abcdef0123456789abcdef01234567",
	commitMessage: "Build revision",
	branch: "main",
};

describe("agent build claim", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectResults.length = 0;
		mocks.updateResults.length = 0;
		mocks.updateSets.length = 0;
		mocks.verifyAgentRequest.mockResolvedValue({
			success: true,
			serverId: "server-1",
		});
		mocks.getSetting.mockResolvedValue(undefined);
	});

	it("does not overwrite cancellation when claim validation fails", async () => {
		mocks.updateResults.push([build], []);
		mocks.selectResults.push(
			[{ id: "service-1", projectId: "project-1" }],
			[],
		);

		const response = await POST(
			new Request("http://localhost/api/v1/agent/builds/build-amd64", {
				method: "POST",
			}) as NextRequest,
			{ params: Promise.resolve({ id: "build-amd64" }) },
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "Build was cancelled while being claimed",
		});
		expect(mocks.updateSets).toHaveLength(2);
		expect(mocks.updateSets[1]).toMatchObject({
			status: "failed",
			error: "Build service revision not found",
			completedAt: expect.any(Date),
		});
		expect(mocks.send).not.toHaveBeenCalled();
	});
});
