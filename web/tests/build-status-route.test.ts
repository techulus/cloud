import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const selectResults: unknown[][] = [];
	const updateResults: unknown[][] = [];
	const updateSets: Array<Record<string, unknown>> = [];
	function selectQuery(result: unknown[]) {
		const query = {
			from: vi.fn(() => query),
			innerJoin: vi.fn(() => query),
			where: vi.fn(() => query),
			limit: vi.fn(() => query),
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
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
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
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
			execute: vi.fn().mockResolvedValue({ rows: [] }),
			transaction: vi.fn(async (callback) => callback(mocks.db)),
		},
		verifyAgentRequest: vi.fn(),
		enqueueWork: vi.fn(),
		send: vi.fn(),
		updateGitHubDeploymentStatus: vi.fn(),
		updateCurrentPreviewGitHubStatus: vi.fn(),
		notify: vi.fn(),
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
vi.mock("@/lib/notifications", () => ({ notify: mocks.notify }));
vi.mock("@/lib/github", () => ({
	updateGitHubDeploymentStatus: mocks.updateGitHubDeploymentStatus,
}));
vi.mock("@/lib/preview-deployments", () => ({
	updateCurrentPreviewGitHubStatus: mocks.updateCurrentPreviewGitHubStatus,
}));
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
const repository = "registry.test/project-1/service-1";
const amd64Image = `${repository}@sha256:${"a".repeat(64)}`;
const arm64Image = `${repository}@sha256:${"b".repeat(64)}`;

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

function post(
	status: string,
	imageUri: string | null | undefined = status === "completed"
		? amd64Image
		: undefined,
) {
	return POST(
		new Request("http://localhost/api/v1/agent/builds/build-amd64/status", {
			method: "POST",
			body: JSON.stringify({ status, resolvedCommitSha: commitSha, imageUri }),
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
		mocks.db.transaction.mockClear();
		mocks.db.execute.mockClear();
		mocks.verifyAgentRequest.mockResolvedValue({
			success: true,
			serverId: "server-1",
		});
		mocks.enqueueWork.mockResolvedValue(undefined);
		mocks.send.mockResolvedValue(undefined);
		mocks.updateGitHubDeploymentStatus.mockResolvedValue(undefined);
		mocks.updateCurrentPreviewGitHubStatus.mockResolvedValue(true);
		mocks.notify.mockResolvedValue(undefined);
	});

	it("enqueues one deterministic notification for a new failed transition", async () => {
		const failedBuild = build("failed");
		mocks.selectResults.push([build("building")], [{ specification }]);
		mocks.updateResults.push([failedBuild]);

		expect((await post("failed")).status).toBe(200);
		expect(mocks.notify).toHaveBeenCalledOnce();
		expect(mocks.notify).toHaveBeenCalledWith({
			kind: "build.failed",
			occurrenceId: "build-amd64",
			serviceId: "service-1",
			buildId: "build-amd64",
			error: undefined,
		});
	});

	it("keeps the service details link on GitHub deployment statuses", async () => {
		const githubSpecification = {
			...specification,
			source: {
				...specification.source,
				authentication: { type: "github_app" as const, installationId: 123 },
			},
		};
		const cloningBuild = build("cloning", { githubDeploymentId: 456 });
		mocks.selectResults.push(
			[build("claimed", { githubDeploymentId: 456, startedAt: null })],
			[
				{
					specification: githubSpecification,
					projectSlug: "cloud",
					environmentName: "production",
				},
			],
		);
		mocks.updateResults.push([cloningBuild]);

		const response = await post("cloning");

		expect(response.status).toBe(200);
		expect(mocks.updateGitHubDeploymentStatus).toHaveBeenCalledWith(
			123,
			"acme/app",
			456,
			"in_progress",
			{
				description: "Build cloning...",
				logUrl: "https://cloud.techulus.com/builds/build-amd64/logs",
				environmentUrl:
					"https://cloud.techulus.com/dashboard/projects/cloud/production/services/service-1",
			},
		);
	});

	it("stores completion and the platform artifact atomically", async () => {
		const completedBuild = build("completed", {
			imageUri: amd64Image,
		});
		const githubSpecification = {
			...specification,
			source: {
				...specification.source,
				authentication: { type: "github_app" as const, installationId: 123 },
			},
		};
		mocks.selectResults.push(
			[build("pushing", { githubDeploymentId: 456 })],
			[
				{
					specification: githubSpecification,
					projectSlug: "cloud",
					environmentName: "production",
				},
			],
			[
				completedBuild,
				build("completed", {
					id: "build-arm64",
					targetPlatform: "linux/arm64",
					imageUri: arm64Image,
				}),
			],
			[{ id: "service-1" }],
		);
		mocks.updateResults.push([completedBuild]);

		const response = await post("completed");

		expect(response.status).toBe(200);
		expect(mocks.updateSets).toHaveLength(1);
		expect(mocks.updateSets[0]).toMatchObject({
			status: "completed",
			imageUri: amd64Image,
			completedAt: expect.any(Date),
		});
		expect(mocks.enqueueWork).toHaveBeenCalledWith(
			"server-1",
			"create_manifest",
			{
				images: [amd64Image, arm64Image],
				finalImageUri: finalImage,
				serviceId: "service-1",
				serviceRevisionId: "revision-1",
				buildGroupId: "group-1",
			},
			{ id: "manifest-work-group-1", tx: mocks.db },
		);
		expect(mocks.createBuildCompleted).toHaveBeenCalledWith(
			expect.objectContaining({ status: "success" }),
			{ id: "build-completed-build-amd64" },
		);
		expect(mocks.updateGitHubDeploymentStatus).toHaveBeenCalledWith(
			123,
			"acme/app",
			456,
			"success",
			{
				description: "Build completed successfully",
				logUrl: "https://cloud.techulus.com/builds/build-amd64/logs",
				environmentUrl:
					"https://cloud.techulus.com/dashboard/projects/cloud/production/services/service-1",
			},
		);
	});

	it("keeps a completed preview build in progress until rollout readiness", async () => {
		const completedBuild = build("completed", {
			githubDeploymentId: 456,
			imageUri: amd64Image,
		});
		const previewSpecification = {
			...specification,
			source: {
				...specification.source,
				authentication: { type: "github_app" as const, installationId: 123 },
			},
		};
		mocks.selectResults.push(
			[
				build("pushing", {
					githubDeploymentId: 456,
				}),
			],
			[
				{
					specification: previewSpecification,
					projectSlug: "cloud",
					environmentName: "production",
					previewOfServiceId: "base-service",
				},
			],
			[completedBuild],
			[
				{
					id: "service-1",
					previewOfServiceId: "base-service",
					previewCurrentRevisionId: "revision-1",
				},
			],
		);
		mocks.updateResults.push([completedBuild]);

		expect((await post("completed")).status).toBe(200);
		expect(mocks.updateCurrentPreviewGitHubStatus).toHaveBeenCalledWith({
			serviceId: "service-1",
			serviceRevisionId: "revision-1",
			expectedDeploymentId: 456,
			state: "in_progress",
			description: "Preview image built; preparing deployment",
			logUrl:
				"https://cloud.techulus.com/dashboard/projects/cloud/production/services/base-service/previews",
		});
		expect(mocks.updateGitHubDeploymentStatus).not.toHaveBeenCalled();
	});

	it("does not enqueue manifest work after the service is deleted", async () => {
		const completedBuild = build("completed", { imageUri: amd64Image });
		mocks.selectResults.push(
			[build("pushing")],
			[{ specification }],
			[completedBuild],
			[],
		);
		mocks.updateResults.push([completedBuild]);

		const response = await post("completed");

		expect(response.status).toBe(200);
		expect(mocks.db.transaction).toHaveBeenCalledOnce();
		expect(mocks.enqueueWork).not.toHaveBeenCalled();
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
			imageUri: amd64Image,
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

	it.each([
		["missing", null],
		["malformed", `${repository}@sha256:ABC`],
	])(
		"rejects a %s completion digest before persistence",
		async (_case, imageUri) => {
			mocks.selectResults.push([build("pushing")], [{ specification }]);

			const response = await post("completed", imageUri);

			expect(response.status).toBe(400);
			expect(mocks.db.update).not.toHaveBeenCalled();
		},
	);

	it("rejects a completion digest for another repository", async () => {
		mocks.selectResults.push([build("pushing")], [{ specification }]);

		const response = await post(
			"completed",
			`registry.test/other/service@sha256:${"c".repeat(64)}`,
		);

		expect(response.status).toBe(409);
		expect(mocks.db.update).not.toHaveBeenCalled();
	});

	it("accepts only an identical digest when replaying completion", async () => {
		const completedBuild = build("completed", { imageUri: amd64Image });
		mocks.selectResults.push(
			[completedBuild],
			[{ specification }],
			[completedBuild],
			[completedBuild],
		);
		mocks.updateResults.push([]);

		expect((await post("completed", amd64Image)).status).toBe(200);

		mocks.selectResults.push(
			[completedBuild],
			[{ specification }],
			[completedBuild],
		);
		mocks.updateResults.push([]);
		expect(
			(await post("completed", `${repository}@sha256:${"d".repeat(64)}`))
				.status,
		).toBe(409);
	});
});
