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
			set: vi.fn((values: Record<string, unknown>) => {
				updateSets.push(values);
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

	const db = {
		select: vi.fn(() => selectQuery(selectResults.shift() ?? [])),
		update: vi.fn(() => updateQuery(updateResults.shift() ?? [])),
		execute: vi.fn().mockResolvedValue(undefined),
		transaction: vi.fn(async (operation: (tx: typeof db) => unknown) =>
			operation(db),
		),
	};

	return {
		selectResults,
		updateResults,
		updateSets,
		db,
		getGitHubPullRequest: vi.fn(),
		listOpenGitHubPullRequests: vi.fn(),
		resolveGitHubPullRequestMergeRef: vi.fn(),
		createGitHubDeployment: vi.fn(),
		updateGitHubDeploymentStatus: vi.fn(),
		createOrRefreshPreviewClone: vi.fn(),
		updateCurrentPreviewGitHubStatus: vi.fn(),
		cancelPreviewRevisionWork: vi.fn(),
		deactivatePreviewRuntime: vi.fn(),
		deletePreviewService: vi.fn(),
		triggerResolvedBuildInternal: vi.fn(),
		parseServiceRevisionSpec: vi.fn(),
		send: vi.fn(),
		createSyncEvent: vi.fn((data, options) => ({
			name: "preview/sync-requested",
			data,
			...options,
		})),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/github", () => ({
	getGitHubPullRequest: mocks.getGitHubPullRequest,
	listOpenGitHubPullRequests: mocks.listOpenGitHubPullRequests,
	resolveGitHubPullRequestMergeRef: mocks.resolveGitHubPullRequestMergeRef,
	createGitHubDeployment: mocks.createGitHubDeployment,
	updateGitHubDeploymentStatus: mocks.updateGitHubDeploymentStatus,
}));
vi.mock("@/lib/preview-deployments", () => ({
	PREVIEW_RECONCILIATION_TTL_MS: 7 * 24 * 60 * 60 * 1000,
	createOrRefreshPreviewClone: mocks.createOrRefreshPreviewClone,
	updateCurrentPreviewGitHubStatus: mocks.updateCurrentPreviewGitHubStatus,
}));
vi.mock("@/lib/preview-lifecycle", () => ({
	cancelPreviewRevisionWork: mocks.cancelPreviewRevisionWork,
	deactivatePreviewRuntime: mocks.deactivatePreviewRuntime,
	deletePreviewService: mocks.deletePreviewService,
}));
vi.mock("@/lib/service-revision-changes", () => ({
	parseServiceRevisionSpec: mocks.parseServiceRevisionSpec,
}));
vi.mock("@/lib/trigger-build", () => ({
	triggerResolvedBuildInternal: mocks.triggerResolvedBuildInternal,
}));
vi.mock("@/lib/inngest/client", () => ({
	inngest: {
		createFunction: vi.fn(
			(_options: unknown, handler: (input: unknown) => unknown) => handler,
		),
		send: mocks.send,
	},
}));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		previewSyncRequested: {
			name: "preview/sync-requested",
			create: mocks.createSyncEvent,
		},
		previewCloseRequested: { name: "preview/close-requested" },
		previewServiceReconcileRequested: {
			name: "preview/service-reconcile-requested",
		},
	},
}));

import {
	previewCloseWorkflow,
	previewServiceReconcileWorkflow,
	previewSyncWorkflow,
} from "@/lib/inngest/functions/preview-workflow";

const baseContext = {
	service: {
		id: "base-service",
		name: "Web",
		previewDeploymentsEnabled: true,
		previewOfServiceId: null,
		stateful: false,
		sourceType: "github" as const,
	},
	githubRepo: {
		installationId: 10,
		repoId: 20,
		repoFullName: "acme/app",
		deployBranch: "main",
		defaultBranch: "main",
	},
};

const pullRequest = {
	number: 42,
	state: "open" as const,
	draft: false,
	merged: false,
	title: "Add preview deployments",
	updatedAt: "2026-08-16T00:00:00Z",
	user: { id: 30, login: "octocat" },
	base: {
		ref: "main",
		repository: { id: 20, fullName: "acme/app" },
	},
	head: {
		sha: "1".repeat(40),
		repository: { id: 20, fullName: "acme/app" },
	},
};

function step() {
	return {
		run: vi.fn(async (_name: string, operation: () => unknown) => operation()),
	};
}

function invoke(
	workflow: unknown,
	data: Record<string, unknown>,
	eventId = "event-1",
) {
	const workflowStep = step();
	const handler = workflow as (input: {
		event: { id: string; data: Record<string, unknown> };
		step: ReturnType<typeof step>;
	}) => Promise<unknown>;
	return {
		result: handler({ event: { id: eventId, data }, step: workflowStep }),
		step: workflowStep,
	};
}

describe("preview lifecycle workflows", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectResults.length = 0;
		mocks.updateResults.length = 0;
		mocks.updateSets.length = 0;
		mocks.createOrRefreshPreviewClone.mockResolvedValue({
			serviceId: "preview-service",
			created: false,
			primaryUrl: "https://web-pr-42.example.com",
		});
		mocks.deletePreviewService.mockResolvedValue({
			service: { id: "preview-service", previewGithubDeploymentId: null },
			githubRepo: baseContext.githubRepo,
		});
		mocks.updateCurrentPreviewGitHubStatus.mockResolvedValue(true);
		mocks.updateGitHubDeploymentStatus.mockResolvedValue(undefined);
		mocks.cancelPreviewRevisionWork.mockResolvedValue(undefined);
		mocks.deactivatePreviewRuntime.mockResolvedValue(undefined);
		mocks.send.mockResolvedValue(undefined);
	});

	it("ignores a delayed close after the pull request was reopened", async () => {
		mocks.selectResults.push(
			[baseContext],
			[
				{
					service: {
						id: "preview-service",
						previewGithubDeploymentId: 99,
					},
					githubRepo: baseContext.githubRepo,
				},
			],
		);
		mocks.getGitHubPullRequest.mockResolvedValue(pullRequest);

		await expect(
			invoke(previewCloseWorkflow, {
				baseServiceId: "base-service",
				pullRequestNumber: 42,
				reason: "pull_request_closed",
				verifyWithGitHub: true,
			}).result,
		).resolves.toEqual({ status: "stale" });

		expect(mocks.deletePreviewService).not.toHaveBeenCalled();
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "preview/sync-requested",
				data: { baseServiceId: "base-service", pullRequestNumber: 42 },
			}),
		);
	});

	it("retries rather than deleting when the authoritative GitHub read fails", async () => {
		mocks.selectResults.push(
			[baseContext],
			[
				{
					service: { id: "preview-service" },
					githubRepo: baseContext.githubRepo,
				},
			],
		);
		mocks.getGitHubPullRequest.mockRejectedValue(
			new Error("GitHub temporarily unavailable"),
		);

		await expect(
			invoke(previewCloseWorkflow, {
				baseServiceId: "base-service",
				pullRequestNumber: 42,
				reason: "pull_request_closed",
				verifyWithGitHub: true,
			}).result,
		).rejects.toThrow("GitHub temporarily unavailable");
		expect(mocks.deletePreviewService).not.toHaveBeenCalled();
	});

	it("finishes teardown even when GitHub cannot mark the deployment inactive", async () => {
		mocks.deletePreviewService.mockResolvedValue({
			service: { id: "preview-service", previewGithubDeploymentId: 99 },
			githubRepo: baseContext.githubRepo,
		});
		mocks.updateGitHubDeploymentStatus.mockRejectedValue(
			new Error("GitHub temporarily unavailable"),
		);

		await expect(
			invoke(previewCloseWorkflow, {
				baseServiceId: "base-service",
				pullRequestNumber: 42,
				reason: "pull_request_merged",
			}).result,
		).resolves.toEqual({
			status: "deleted",
			serviceId: "preview-service",
		});
		expect(mocks.deletePreviewService).toHaveBeenCalledWith("base-service", 42);
	});

	it("deactivates the old runtime when the merge ref is unavailable", async () => {
		mocks.selectResults.push(
			[baseContext],
			[
				{
					previewCurrentRevisionId: "revision-old",
					previewGithubDeploymentId: 98,
					previewError: null,
				},
			],
			[{ specification: { source: "old" } }],
			[
				{
					previewCurrentRevisionId: "revision-old",
					previewGithubDeploymentId: 98,
				},
			],
		);
		mocks.getGitHubPullRequest.mockResolvedValue(pullRequest);
		mocks.parseServiceRevisionSpec.mockReturnValue({
			source: { type: "github", commitSha: "2".repeat(40) },
		});
		mocks.resolveGitHubPullRequestMergeRef.mockRejectedValue(
			new Error("Merge ref refs/pull/42/merge is unavailable"),
		);

		await expect(
			invoke(previewSyncWorkflow, {
				baseServiceId: "base-service",
				pullRequestNumber: 42,
			}).result,
		).resolves.toEqual({
			status: "failed",
			reason: "merge_ref_unavailable",
		});

		expect(mocks.deactivatePreviewRuntime).toHaveBeenCalledWith(
			"preview-service",
		);
		expect(mocks.updateGitHubDeploymentStatus).toHaveBeenCalledWith(
			10,
			"acme/app",
			98,
			"inactive",
			{ description: "Preview merge ref is unavailable" },
		);
		expect(mocks.triggerResolvedBuildInternal).not.toHaveBeenCalled();
	});

	it("does not rebuild an unchanged merge commit unless forced", async () => {
		mocks.selectResults.push(
			[baseContext],
			[
				{
					previewCurrentRevisionId: "revision-current",
					previewGithubDeploymentId: 99,
					previewError: null,
				},
			],
			[{ specification: { source: "current" } }],
		);
		mocks.getGitHubPullRequest.mockResolvedValue(pullRequest);
		mocks.parseServiceRevisionSpec.mockReturnValue({
			source: { type: "github", commitSha: "3".repeat(40) },
		});
		mocks.resolveGitHubPullRequestMergeRef.mockResolvedValue({
			gitRef: "refs/pull/42/merge",
			sha: "3".repeat(40),
		});

		await expect(
			invoke(previewSyncWorkflow, {
				baseServiceId: "base-service",
				pullRequestNumber: 42,
			}).result,
		).resolves.toEqual({ status: "unchanged", serviceId: "preview-service" });
		expect(mocks.createGitHubDeployment).not.toHaveBeenCalled();
		expect(mocks.triggerResolvedBuildInternal).not.toHaveBeenCalled();
	});

	it("forces an exact merge-ref rebuild and supersedes the old revision", async () => {
		mocks.selectResults.push(
			[baseContext],
			[
				{
					previewCurrentRevisionId: "revision-current",
					previewGithubDeploymentId: 99,
					previewError: null,
				},
			],
			[{ specification: { source: "current" } }],
		);
		mocks.updateResults.push([{ id: "preview-service" }]);
		mocks.getGitHubPullRequest.mockResolvedValue(pullRequest);
		mocks.parseServiceRevisionSpec.mockReturnValue({
			source: { type: "github", commitSha: "3".repeat(40) },
		});
		mocks.resolveGitHubPullRequestMergeRef.mockResolvedValue({
			gitRef: "refs/pull/42/merge",
			sha: "3".repeat(40),
		});
		mocks.createGitHubDeployment.mockResolvedValue(100);
		mocks.triggerResolvedBuildInternal.mockImplementation(
			async (_serviceId, input) => {
				await input.beforeDispatch("revision-forced");
				return {
					buildId: null,
					serviceRevisionId: "revision-forced",
					status: "queued",
				};
			},
		);

		await expect(
			invoke(
				previewSyncWorkflow,
				{
					baseServiceId: "base-service",
					pullRequestNumber: 42,
					force: true,
				},
				"redeploy-event",
			).result,
		).resolves.toMatchObject({
			status: "queued",
			serviceRevisionId: "revision-forced",
			deploymentId: 100,
		});

		expect(mocks.triggerResolvedBuildInternal).toHaveBeenCalledWith(
			"preview-service",
			expect.objectContaining({
				trigger: "preview",
				commitSha: "3".repeat(40),
				gitRef: "refs/pull/42/merge",
				idempotencyKey: expect.stringContaining("redeploy-event"),
			}),
		);
		expect(mocks.cancelPreviewRevisionWork).toHaveBeenCalledWith(
			"preview-service",
			"revision-current",
		);
		expect(mocks.updateCurrentPreviewGitHubStatus).toHaveBeenCalledWith({
			serviceId: "preview-service",
			serviceRevisionId: "revision-forced",
			expectedDeploymentId: 100,
			state: "pending",
			description: "Preview build queued",
		});
	});

	it("reconciliation creates missing previews and removes stale ones", async () => {
		const secondPullRequest = {
			...pullRequest,
			number: 43,
			updatedAt: "2026-08-16T01:00:00Z",
		};
		mocks.selectResults.push(
			[baseContext],
			[{ pullRequestNumber: 42 }, { pullRequestNumber: 99 }],
		);
		mocks.listOpenGitHubPullRequests.mockResolvedValue([
			pullRequest,
			secondPullRequest,
		]);

		await expect(
			invoke(previewServiceReconcileWorkflow, {
				baseServiceId: "base-service",
			}).result,
		).resolves.toEqual({ status: "queued", count: 2, closed: 1 });

		expect(mocks.deletePreviewService).toHaveBeenCalledWith("base-service", 99);
		expect(mocks.send).toHaveBeenCalledTimes(2);
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { baseServiceId: "base-service", pullRequestNumber: 43 },
			}),
		);
	});
});
