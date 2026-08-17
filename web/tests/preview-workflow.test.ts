import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const selectResults: unknown[][] = [];
	function query(result: unknown[]) {
		const value = {
			from: vi.fn(() => value),
			innerJoin: vi.fn(() => value),
			where: vi.fn(() => value),
			orderBy: vi.fn(() => value),
			limit: vi.fn(() => value),
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
			then: (
				resolve: (rows: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return value;
	}
	const db = { select: vi.fn(() => query(selectResults.shift() ?? [])) };
	return {
		selectResults,
		db,
		getGitHubPullRequest: vi.fn(),
		listOpenGitHubPullRequests: vi.fn(),
		resolveGitHubPullRequestMergeRef: vi.fn(),
		createPreviewClone: vi.fn(),
		inactivatePreviewGitHubDeployments: vi.fn(),
		cancelPreviewRevisionWork: vi.fn(),
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
}));
vi.mock("@/lib/preview-deployments", () => ({
	createPreviewClone: mocks.createPreviewClone,
	inactivatePreviewGitHubDeployments: mocks.inactivatePreviewGitHubDeployments,
}));
vi.mock("@/lib/preview-lifecycle", () => ({
	cancelPreviewRevisionWork: mocks.cancelPreviewRevisionWork,
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

import { previewSyncWorkflow } from "@/lib/inngest/functions/preview-workflow";

const baseContext = {
	service: {
		id: "base-service",
		previewDeploymentsEnabled: true,
		previewOfService: null,
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
	title: "Add previews",
	updatedAt: "2026-08-16T00:00:00Z",
	user: { id: 30, login: "octocat" },
	base: { ref: "main", repository: { id: 20, fullName: "acme/app" } },
	head: { sha: "1".repeat(40), repository: { id: 20, fullName: "acme/app" } },
};

function invoke(
	workflow: unknown,
	data: Record<string, unknown>,
	name = "preview/sync-requested",
) {
	return (
		workflow as (input: {
			event: { id: string; name: string; data: Record<string, unknown> };
			step: { run: (_name: string, operation: () => unknown) => unknown };
		}) => Promise<unknown>
	)({
		event: { id: "event-1", name, data },
		step: { run: async (_name, operation) => operation() },
	});
}

describe("preview lifecycle workflows", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectResults.length = 0;
		mocks.createPreviewClone.mockResolvedValue({
			serviceId: "preview-service",
			created: false,
			primaryUrl: "https://preview.example.com",
		});
		mocks.getGitHubPullRequest.mockResolvedValue(pullRequest);
		mocks.deletePreviewService.mockResolvedValue({
			service: { id: "preview-service" },
		});
		mocks.inactivatePreviewGitHubDeployments.mockResolvedValue(1);
		mocks.cancelPreviewRevisionWork.mockResolvedValue(undefined);
		mocks.send.mockResolvedValue(undefined);
	});

	it("builds the exact merge ref and supersedes the prior revision", async () => {
		mocks.selectResults.push(
			[baseContext],
			[{ previewOfService: "base-service" }],
			[{ id: "revision-old", specification: {} }],
		);
		mocks.parseServiceRevisionSpec.mockReturnValue({
			source: { type: "github", commitSha: "2".repeat(40) },
		});
		mocks.resolveGitHubPullRequestMergeRef.mockResolvedValue({
			gitRef: "refs/pull/42/merge",
			sha: "3".repeat(40),
		});
		mocks.triggerResolvedBuildInternal.mockResolvedValue({
			status: "queued",
			serviceRevisionId: "revision-new",
		});

		await expect(
			invoke(previewSyncWorkflow, {
				baseServiceId: "base-service",
				previewGitRef: "refs/pull/42/merge",
			}),
		).resolves.toMatchObject({ serviceRevisionId: "revision-new" });
		expect(mocks.triggerResolvedBuildInternal).toHaveBeenCalledWith(
			"preview-service",
			expect.objectContaining({
				trigger: "preview",
				commitSha: "3".repeat(40),
				gitRef: "refs/pull/42/merge",
			}),
		);
		expect(mocks.cancelPreviewRevisionWork).toHaveBeenCalledWith(
			"preview-service",
			"revision-old",
		);
		expect(mocks.inactivatePreviewGitHubDeployments).toHaveBeenCalledWith({
			serviceId: "preview-service",
			excludeServiceRevisionId: "revision-new",
			description: "Superseded by a newer preview revision",
		});
	});

	it("deletes the preview when GitHub has no merge ref", async () => {
		mocks.selectResults.push(
			[baseContext],
			[{ previewOfService: "base-service" }],
			[],
		);
		mocks.resolveGitHubPullRequestMergeRef.mockRejectedValue(
			new Error("merge ref unavailable"),
		);

		await expect(
			invoke(previewSyncWorkflow, {
				baseServiceId: "base-service",
				previewGitRef: "refs/pull/42/merge",
			}),
		).resolves.toEqual({
			status: "failed",
			reason: "merge_ref_unavailable",
		});
		expect(mocks.deletePreviewService).toHaveBeenCalledWith(
			"base-service",
			"refs/pull/42/merge",
			"merge ref is unavailable",
		);
		expect(mocks.triggerResolvedBuildInternal).not.toHaveBeenCalled();
	});

	it("deletes the preview when a pull request closes", async () => {
		await expect(
			invoke(
				previewSyncWorkflow,
				{
					baseServiceId: "base-service",
					previewGitRef: "refs/pull/42/merge",
					reason: "pull_request_closed",
				},
				"preview/close-requested",
			),
		).resolves.toEqual({ status: "deleted", serviceId: "preview-service" });
		expect(mocks.deletePreviewService).toHaveBeenCalledWith(
			"base-service",
			"refs/pull/42/merge",
			"pull_request_closed",
		);
	});
});
