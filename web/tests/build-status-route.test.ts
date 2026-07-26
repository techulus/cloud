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
		enqueueWork: vi.fn(),
		send: vi.fn(),
		createBuildCompleted: vi.fn((data, options) => ({
			name: "build/completed",
			data,
			...options,
		})),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/agent-auth", () => ({
	verifyAgentRequest: mocks.verifyAgentRequest,
}));
vi.mock("@/lib/email", () => ({ sendBuildFailureAlert: vi.fn() }));
vi.mock("@/lib/github", () => ({ updateGitHubDeploymentStatus: vi.fn() }));
vi.mock("@/lib/work-queue", () => ({ enqueueWork: mocks.enqueueWork }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		buildCompleted: { create: mocks.createBuildCompleted },
	},
}));

import { POST } from "@/app/api/v1/agent/builds/[id]/status/route";

const commitSha = "0123456789abcdef0123456789abcdef01234567";
const finalImage = "registry.test/project-1/service-1:revision-revision-1";

const specification = {
	schemaVersion: 2,
	image: finalImage,
	source: {
		type: "github",
		repository: "https://github.com/acme/app",
		repositoryId: null,
		branch: "main",
		commitSha,
		rootDir: "apps/web",
		authentication: { type: "anonymous" },
	},
	hostname: "service-1",
	stateful: false,
	serverless: {
		enabled: false,
		sleepAfterSeconds: 300,
		wakeTimeoutSeconds: 300,
	},
	healthCheck: null,
	startCommand: null,
	resourceLimits: { cpuCores: null, memoryMb: null },
	placements: [{ serverId: "server-1", count: 1 }],
	ports: [],
	secrets: [],
	volumes: [],
};

function build(status: string, overrides: Record<string, unknown> = {}) {
	return {
		id: "build-amd64",
		serviceId: "service-1",
		serviceRevisionId: "revision-1",
		buildGroupId: "group-1",
		targetPlatform: "linux/amd64",
		commitSha,
		branch: "main",
		status,
		claimedBy: "server-1",
		startedAt: new Date(),
		githubDeploymentId: null,
		imageUri: null,
		...overrides,
	};
}

function post(status: string) {
	return POST(
		new Request("http://localhost/api/v1/agent/builds/build-amd64/status", {
			method: "POST",
			body: JSON.stringify({ status, resolvedCommitSha: commitSha }),
		}) as NextRequest,
		{ params: Promise.resolve({ id: "build-amd64" }) },
	);
}

describe("agent build status transitions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectResults.length = 0;
		mocks.updateResults.length = 0;
		mocks.updateSets.length = 0;
		mocks.verifyAgentRequest.mockResolvedValue({
			success: true,
			serverId: "server-1",
		});
		mocks.enqueueWork.mockResolvedValue(undefined);
		mocks.send.mockResolvedValue(undefined);
	});

	it("stores completion and the platform artifact atomically", async () => {
		const completedBuild = build("completed", {
			imageUri: `${finalImage}-amd64`,
		});
		mocks.selectResults.push(
			[build("pushing")],
			[{ specification }],
			[
				completedBuild,
				build("completed", {
					id: "build-arm64",
					targetPlatform: "linux/arm64",
					imageUri: `${finalImage}-arm64`,
				}),
			],
		);
		mocks.updateResults.push([completedBuild]);

		const response = await post("completed");

		expect(response.status).toBe(200);
		expect(mocks.updateSets).toHaveLength(1);
		expect(mocks.updateSets[0]).toMatchObject({
			status: "completed",
			imageUri: `${finalImage}-amd64`,
			completedAt: expect.any(Date),
		});
		expect(mocks.enqueueWork).toHaveBeenCalledWith(
			"server-1",
			"create_manifest",
			{
				images: [`${finalImage}-amd64`, `${finalImage}-arm64`],
				finalImageUri: finalImage,
				serviceId: "service-1",
				serviceRevisionId: "revision-1",
				buildGroupId: "group-1",
			},
			{ id: "manifest-work-group-1" },
		);
		expect(mocks.createBuildCompleted).toHaveBeenCalledWith(
			expect.objectContaining({ status: "success" }),
			{ id: "build-completed-build-amd64" },
		);
	});

	it("does not overwrite a concurrent cancellation", async () => {
		mocks.selectResults.push(
			[build("pushing")],
			[{ specification }],
			[build("cancelled")],
		);
		mocks.updateResults.push([]);

		const response = await post("completed");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, cancelled: true });
		expect(mocks.enqueueWork).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("rejects reversal of a completed build to failed", async () => {
		const completedBuild = build("completed", {
			imageUri: `${finalImage}-amd64`,
		});
		mocks.selectResults.push(
			[completedBuild],
			[{ specification }],
			[completedBuild],
		);
		mocks.updateResults.push([]);

		const response = await post("failed");

		expect(response.status).toBe(409);
		expect(mocks.enqueueWork).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	});
});
