import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[][],
	select: vi.fn(),
	send: vi.fn(),
	resolveGitHubCommit: vi.fn(),
	createBuildTrigger: vi.fn((data) => ({ name: "build/trigger", data })),
	createGitHubBuildServiceRevision: vi.fn(),
	cloneGitHubBuildServiceRevision: vi.fn(),
}));

vi.mock("@/db", () => ({
	db: { select: mocks.select },
}));
vi.mock("@/lib/inngest/client", () => ({
	inngest: { send: mocks.send },
}));
vi.mock("@/lib/github", () => ({
	resolveGitHubCommit: mocks.resolveGitHubCommit,
}));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		buildTrigger: { create: mocks.createBuildTrigger },
	},
}));
vi.mock("@/lib/service-revisions", () => ({
	createGitHubBuildServiceRevision: mocks.createGitHubBuildServiceRevision,
	cloneGitHubBuildServiceRevision: mocks.cloneGitHubBuildServiceRevision,
}));

import {
	requeueBuildRevisionInternal,
	triggerBuildInternal,
} from "@/lib/trigger-build";

function queryReturning(rows: unknown[]) {
	const query = {
		from: vi.fn(),
		where: vi.fn(),
		limit: vi.fn(),
		// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
		then: (resolve: (value: unknown[]) => unknown) =>
			Promise.resolve(rows).then(resolve),
	};
	query.from.mockReturnValue(query);
	query.where.mockReturnValue(query);
	query.limit.mockReturnValue(query);
	return query;
}

describe("internal GitHub build trigger", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.REGISTRY_HOST = "registry.test";
		mocks.rows = [];
		mocks.createGitHubBuildServiceRevision.mockResolvedValue({});
		mocks.resolveGitHubCommit.mockResolvedValue({
			sha: "0123456789abcdef0123456789abcdef01234567",
			message: "Resolved source commit",
			author: "octocat",
			date: "2026-07-20T00:00:00Z",
		});
		mocks.select.mockImplementation(() =>
			queryReturning(mocks.rows.shift() ?? []),
		);
	});

	it("uses App-backed repository precedence and preserves the actor", async () => {
		mocks.rows = [
			[
				{
					id: "service-1",
					projectId: "project-1",
					sourceType: "github",
					deletedAt: null,
					githubRepoUrl: "https://github.com/stale/fallback",
					githubBranch: "stale",
					githubRootDir: "apps/web",
				},
			],
			[
				{
					id: "repo-1",
					installationId: 123,
					repoFullName: "acme/app",
					deployBranch: "production",
					defaultBranch: "main",
				},
			],
		];
		const actor = { type: "user" as const, userId: "user-1", name: "Alice" };

		await expect(
			triggerBuildInternal("service-1", "manual", actor),
		).resolves.toEqual(
			expect.objectContaining({ buildId: null, status: "queued" }),
		);
		const revision = mocks.createGitHubBuildServiceRevision.mock.calls[0][0];
		expect(revision).toEqual(
			expect.objectContaining({
				serviceId: "service-1",
				image: `registry.test/project-1/service-1:revision-${revision.id}`,
				commitSha: "0123456789abcdef0123456789abcdef01234567",
				expectedRepository: "https://github.com/acme/app",
				expectedBranch: "production",
				actor,
			}),
		);
		expect(mocks.createBuildTrigger).toHaveBeenCalledWith({
			serviceId: "service-1",
			serviceRevisionId: revision.id,
			buildRequestId: expect.any(String),
			trigger: "manual",
			commitSha: "0123456789abcdef0123456789abcdef01234567",
			commitMessage: "Resolved source commit",
			branch: "production",
			author: "octocat",
			actor,
			githubDeploymentId: undefined,
		});
		expect(mocks.resolveGitHubCommit).toHaveBeenCalledWith(
			"acme/app",
			"production",
			123,
		);
		expect(mocks.send).toHaveBeenCalledTimes(1);
	});

	it("supports a public URL-backed repository without a GitHub App row", async () => {
		mocks.rows = [
			[
				{
					id: "service-1",
					projectId: "project-1",
					sourceType: "github",
					deletedAt: null,
					githubRepoUrl: "https://github.com/acme/public",
					githubBranch: "preview",
					githubRootDir: "services/api",
				},
			],
			[],
		];

		await triggerBuildInternal("service-1", "scheduled", { type: "system" });

		const revision = mocks.createGitHubBuildServiceRevision.mock.calls[0][0];
		expect(revision).toEqual(
			expect.objectContaining({
				expectedRepository: "https://github.com/acme/public",
				expectedBranch: "preview",
			}),
		);
		expect(mocks.createBuildTrigger).toHaveBeenCalledWith({
			serviceId: "service-1",
			serviceRevisionId: revision.id,
			buildRequestId: expect.any(String),
			trigger: "scheduled",
			commitSha: "0123456789abcdef0123456789abcdef01234567",
			commitMessage: "Resolved source commit",
			branch: "preview",
			author: "octocat",
			actor: { type: "system" },
			githubDeploymentId: undefined,
		});
		expect(mocks.resolveGitHubCommit).toHaveBeenCalledWith(
			"acme/public",
			"preview",
			undefined,
		);
	});

	it("rejects a non-GitHub service before queueing work", async () => {
		mocks.rows = [
			[
				{
					id: "service-1",
					sourceType: "image",
					deletedAt: null,
				},
			],
		];

		await expect(
			triggerBuildInternal("service-1", "manual", { type: "system" }),
		).rejects.toThrow("Active GitHub service not found");
		expect(mocks.send).not.toHaveBeenCalled();
		expect(mocks.createGitHubBuildServiceRevision).not.toHaveBeenCalled();
	});

	it("retries from a cloned revision with a new artifact identity", async () => {
		const retrySpecification = {
			schemaVersion: 2,
			image: "registry.test/project-1/service-1:revision-retry-1",
			source: {
				type: "github",
				repository: "https://github.com/acme/app",
				repositoryId: 101,
				branch: "main",
				commitSha: "0123456789abcdef0123456789abcdef01234567",
				rootDir: "apps/web",
				authentication: { type: "github_app", installationId: 123 },
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
		mocks.cloneGitHubBuildServiceRevision.mockResolvedValue({
			id: "retry-1",
			specification: retrySpecification,
		});
		const actor = { type: "user" as const, userId: "user-1", name: "Alice" };

		await expect(
			requeueBuildRevisionInternal({
				serviceId: "service-1",
				serviceRevisionId: "failed-revision",
				commitMessage: "Retry immutable source",
				actor,
			}),
		).resolves.toEqual({
			status: "queued",
			serviceRevisionId: "retry-1",
			buildRequestId: expect.any(String),
		});
		expect(mocks.cloneGitHubBuildServiceRevision).toHaveBeenCalledWith({
			serviceId: "service-1",
			sourceRevisionId: "failed-revision",
			actor,
		});
		expect(mocks.createBuildTrigger).toHaveBeenCalledWith(
			expect.objectContaining({
				serviceId: "service-1",
				serviceRevisionId: "retry-1",
				commitSha: retrySpecification.source.commitSha,
				branch: "main",
			}),
		);
	});
});
