import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const queryResults: unknown[][] = [];

	function createQuery(result: unknown[]) {
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

	return {
		queryResults,
		db: {
			select: vi.fn(() => createQuery(queryResults.shift() ?? [])),
		},
		verifyWebhookSignature: vi.fn(),
		createGitHubDeployment: vi.fn(),
		updateGitHubDeploymentStatus: vi.fn(),
		send: vi.fn(),
		createBuildTrigger: vi.fn(),
		createPreviewSync: vi.fn(),
		createPreviewClose: vi.fn(),
		triggerResolvedBuildInternal: vi.fn(),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/github", () => ({
	verifyWebhookSignature: mocks.verifyWebhookSignature,
	createGitHubDeployment: mocks.createGitHubDeployment,
	updateGitHubDeploymentStatus: mocks.updateGitHubDeploymentStatus,
}));
vi.mock("@/lib/inngest/client", () => ({
	inngest: { send: mocks.send },
}));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		buildTrigger: { create: mocks.createBuildTrigger },
		previewSyncRequested: { create: mocks.createPreviewSync },
		previewCloseRequested: { create: mocks.createPreviewClose },
	},
}));
vi.mock("@/lib/trigger-build", () => ({
	triggerResolvedBuildInternal: mocks.triggerResolvedBuildInternal,
}));

import { POST } from "@/app/api/webhooks/github/route";

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

function linkedService({
	serviceId,
	name = serviceId,
	branch = "main",
	autoDeploy = true,
	sourceType = "github",
	deletedAt = null,
	rootDir = "",
	projectName = "Cloud",
	projectSlug = "cloud",
	environmentName = "production",
	previewDeploymentsEnabled = false,
	previewOfService = null,
	previewGitRef = null,
	stateful = false,
}: {
	serviceId: string;
	name?: string;
	branch?: string;
	autoDeploy?: boolean;
	sourceType?: "github" | "image";
	deletedAt?: Date | null;
	rootDir?: string;
	projectName?: string;
	projectSlug?: string;
	environmentName?: string;
	previewDeploymentsEnabled?: boolean;
	previewOfService?: string | null;
	previewGitRef?: string | null;
	stateful?: boolean;
}) {
	return {
		githubRepo: {
			id: `link-${serviceId}`,
			installationId: 123,
			repoId: 456,
			repoFullName: "techulus/cloud",
			defaultBranch: "main",
			serviceId,
			deployBranch: branch,
			autoDeploy,
			createdAt: new Date("2026-07-19T00:00:00Z"),
		},
		service: {
			id: serviceId,
			name,
			sourceType,
			deletedAt,
			githubRootDir: rootDir,
			previewDeploymentsEnabled,
			previewOfService,
			previewGitRef,
			stateful,
		},
		project: { id: "project-1", name: projectName, slug: projectSlug },
		environment: { id: "environment-1", name: environmentName },
	};
}

function pushRequest(branch = "main") {
	return new NextRequest("http://localhost/api/webhooks/github", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": "push",
			"x-hub-signature-256": "sha256=test",
		},
		body: JSON.stringify({
			ref: `refs/heads/${branch}`,
			repository: {
				id: 456,
				full_name: "techulus/cloud",
				default_branch: "main",
			},
			head_commit: {
				id: COMMIT_SHA,
				message: "Ship multi-service webhook fan-out",
				author: { name: "Octo Cat", username: "octocat" },
			},
			sender: { id: 789, login: "octocat" },
		}),
	});
}

function pullRequest(
	action: string,
	options: {
		draft?: boolean;
		merged?: boolean;
		headRepoId?: number;
		baseBranch?: string;
	} = {},
) {
	return new NextRequest("http://localhost/api/webhooks/github", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": "pull_request",
			"x-github-delivery": `delivery-${action}`,
			"x-hub-signature-256": "sha256=test",
		},
		body: JSON.stringify({
			action,
			number: 42,
			repository: { id: 456, full_name: "techulus/cloud" },
			pull_request: {
				draft: options.draft ?? false,
				merged: options.merged ?? false,
				base: {
					ref: options.baseBranch ?? "main",
					repo: { id: 456, full_name: "techulus/cloud" },
				},
				head: {
					repo: {
						id: options.headRepoId ?? 456,
						full_name: "techulus/cloud",
					},
				},
			},
		}),
	});
}

describe("GitHub push webhook", () => {
	beforeEach(() => {
		mocks.queryResults.length = 0;
		mocks.db.select.mockClear();
		mocks.verifyWebhookSignature.mockReset();
		mocks.verifyWebhookSignature.mockReturnValue(true);
		mocks.createGitHubDeployment.mockReset();
		mocks.createGitHubDeployment.mockResolvedValue(1000);
		mocks.updateGitHubDeploymentStatus.mockReset();
		mocks.updateGitHubDeploymentStatus.mockResolvedValue(undefined);
		mocks.send.mockReset();
		mocks.send.mockResolvedValue(undefined);
		mocks.createBuildTrigger.mockReset();
		mocks.createBuildTrigger.mockImplementation((data, options) => ({
			name: "build/trigger",
			data,
			...options,
		}));
		mocks.createPreviewSync.mockReset();
		mocks.createPreviewSync.mockImplementation((data, options) => ({
			name: "preview/sync-requested",
			data,
			...options,
		}));
		mocks.createPreviewClose.mockReset();
		mocks.createPreviewClose.mockImplementation((data, options) => ({
			name: "preview/close-requested",
			data,
			...options,
		}));
		mocks.triggerResolvedBuildInternal.mockReset();
		mocks.triggerResolvedBuildInternal.mockResolvedValue({ status: "queued" });
	});

	it("queues every active service linked to the pushed repository and branch", async () => {
		mocks.queryResults.push(
			[
				linkedService({
					serviceId: "service-a",
					name: "web",
					rootDir: "apps/web",
				}),
				linkedService({ serviceId: "service-b", name: "web" }),
			],
			[],
			[],
		);
		mocks.createGitHubDeployment
			.mockResolvedValueOnce(1001)
			.mockResolvedValueOnce(1002);

		const response = await POST(pushRequest());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			results: [
				{ serviceId: "service-a", status: "queued" },
				{ serviceId: "service-b", status: "queued" },
			],
		});
		expect(mocks.triggerResolvedBuildInternal).toHaveBeenCalledTimes(2);
		expect(mocks.triggerResolvedBuildInternal).toHaveBeenNthCalledWith(
			1,
			"service-a",
			expect.objectContaining({
				githubDeploymentId: 1001,
				expectedRepository: "https://github.com/techulus/cloud",
				expectedBranch: "main",
				idempotencyKey: `github-push:link-service-a:${COMMIT_SHA}`,
			}),
		);
		expect(mocks.triggerResolvedBuildInternal).toHaveBeenNthCalledWith(
			2,
			"service-b",
			expect.objectContaining({
				githubDeploymentId: 1002,
				idempotencyKey: `github-push:link-service-b:${COMMIT_SHA}`,
			}),
		);
		expect(mocks.createGitHubDeployment).toHaveBeenNthCalledWith(
			1,
			123,
			"techulus/cloud",
			COMMIT_SHA,
			"cloud / production / web",
			expect.any(String),
		);
		expect(mocks.createGitHubDeployment).toHaveBeenNthCalledWith(
			2,
			123,
			"techulus/cloud",
			COMMIT_SHA,
			"cloud / production / web",
			expect.any(String),
		);
		expect(mocks.updateGitHubDeploymentStatus).toHaveBeenNthCalledWith(
			1,
			123,
			"techulus/cloud",
			1001,
			"pending",
			{
				description: "Build queued",
				environmentUrl:
					"https://cloud.techulus.com/dashboard/projects/cloud/production/services/service-a",
			},
		);
	});

	it("only queues services configured for the pushed branch", async () => {
		mocks.queryResults.push(
			[
				linkedService({ serviceId: "service-main" }),
				linkedService({ serviceId: "service-staging", branch: "staging" }),
			],
			[],
		);

		const response = await POST(pushRequest("main"));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.results).toEqual([
			{ serviceId: "service-main", status: "queued" },
			{
				serviceId: "service-staging",
				status: "skipped",
				reason: "branch mismatch: main != staging",
			},
		]);
		expect(mocks.triggerResolvedBuildInternal).toHaveBeenCalledTimes(1);
	});

	it("does not let an ineligible or previously built service suppress another link", async () => {
		mocks.queryResults.push(
			[
				linkedService({ serviceId: "service-disabled", autoDeploy: false }),
				linkedService({
					serviceId: "service-deleted",
					deletedAt: new Date("2026-07-19T00:00:00Z"),
				}),
				linkedService({ serviceId: "service-image", sourceType: "image" }),
				linkedService({ serviceId: "service-existing" }),
				linkedService({ serviceId: "service-eligible" }),
			],
			[{ id: "build-existing" }],
			[],
		);

		const response = await POST(pushRequest());
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.results).toEqual([
			{
				serviceId: "service-disabled",
				status: "skipped",
				reason: "auto-deploy disabled",
			},
			{
				serviceId: "service-deleted",
				status: "skipped",
				reason: "service deleted",
			},
			{
				serviceId: "service-image",
				status: "skipped",
				reason: "service not connected to GitHub",
			},
			{
				serviceId: "service-existing",
				status: "skipped",
				reason: "build already exists for this commit",
				buildId: "build-existing",
			},
			{ serviceId: "service-eligible", status: "queued" },
		]);
		expect(mocks.triggerResolvedBuildInternal).toHaveBeenCalledTimes(1);
		expect(mocks.triggerResolvedBuildInternal).toHaveBeenCalledWith(
			"service-eligible",
			expect.any(Object),
		);
	});

	it("attempts every service and reports a failed build dispatch", async () => {
		mocks.queryResults.push(
			[
				linkedService({ serviceId: "service-deployment-error" }),
				linkedService({ serviceId: "service-send-error" }),
				linkedService({ serviceId: "service-later" }),
			],
			[],
			[],
			[],
		);
		mocks.createGitHubDeployment
			.mockRejectedValueOnce(new Error("GitHub unavailable"))
			.mockResolvedValueOnce(1002)
			.mockResolvedValueOnce(1003);
		mocks.triggerResolvedBuildInternal
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("Inngest unavailable"))
			.mockResolvedValueOnce(undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		const response = await POST(pushRequest());

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			ok: false,
			results: [
				{ serviceId: "service-deployment-error", status: "queued" },
				{
					serviceId: "service-send-error",
					status: "failed",
					reason: "failed to queue build",
				},
				{ serviceId: "service-later", status: "queued" },
			],
		});
		expect(mocks.triggerResolvedBuildInternal).toHaveBeenCalledTimes(3);
		expect(mocks.triggerResolvedBuildInternal).toHaveBeenNthCalledWith(
			1,
			"service-deployment-error",
			expect.objectContaining({
				githubDeploymentId: undefined,
			}),
		);
		expect(mocks.triggerResolvedBuildInternal).toHaveBeenNthCalledWith(
			3,
			"service-later",
			expect.any(Object),
		);
	});
});

describe("GitHub pull request webhook", () => {
	beforeEach(() => {
		mocks.queryResults.length = 0;
		mocks.verifyWebhookSignature.mockReturnValue(true);
		mocks.send.mockReset();
		mocks.send.mockResolvedValue(undefined);
		mocks.createPreviewSync.mockImplementation((data, options) => ({
			name: "preview/sync-requested",
			data,
			...options,
		}));
		mocks.createPreviewClose.mockImplementation((data, options) => ({
			name: "preview/close-requested",
			data,
			...options,
		}));
	});

	it("queues one durable sync per eligible enabled base service", async () => {
		mocks.queryResults.push([
			linkedService({
				serviceId: "service-a",
				previewDeploymentsEnabled: true,
			}),
			linkedService({
				serviceId: "service-b",
				previewDeploymentsEnabled: true,
			}),
			linkedService({ serviceId: "service-disabled" }),
			linkedService({
				serviceId: "service-stateful",
				previewDeploymentsEnabled: true,
				stateful: true,
			}),
		]);

		const response = await POST(pullRequest("opened"));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, queued: 4 });
		expect(mocks.send).toHaveBeenCalledWith([
			expect.objectContaining({
				name: "preview/sync-requested",
				data: {
					baseServiceId: "service-a",
					previewGitRef: "refs/pull/42/merge",
				},
			}),
			expect.objectContaining({
				name: "preview/sync-requested",
				data: {
					baseServiceId: "service-b",
					previewGitRef: "refs/pull/42/merge",
				},
			}),
			expect.objectContaining({
				name: "preview/close-requested",
				data: expect.objectContaining({
					baseServiceId: "service-disabled",
					previewGitRef: "refs/pull/42/merge",
				}),
			}),
			expect.objectContaining({
				name: "preview/close-requested",
				data: expect.objectContaining({
					baseServiceId: "service-stateful",
					previewGitRef: "refs/pull/42/merge",
				}),
			}),
		]);
	});

	it("closes an existing preview when the pull request changes base branch", async () => {
		mocks.queryResults.push([
			linkedService({
				serviceId: "service-a",
				previewDeploymentsEnabled: true,
			}),
		]);

		const response = await POST(
			pullRequest("edited", { baseBranch: "release" }),
		);

		expect(response.status).toBe(200);
		expect(mocks.send).toHaveBeenCalledWith([
			expect.objectContaining({
				name: "preview/close-requested",
				data: {
					baseServiceId: "service-a",
					previewGitRef: "refs/pull/42/merge",
					reason: "pull_request_ineligible",
					verifyWithGitHub: true,
				},
			}),
		]);
	});

	it.each([
		["draft", { draft: true }],
		["fork", { headRepoId: 999 }],
	])(
		"queues teardown instead of deploying a %s pull request",
		async (_case, options) => {
			mocks.queryResults.push([
				linkedService({
					serviceId: "service-a",
					previewDeploymentsEnabled: true,
				}),
			]);

			const response = await POST(pullRequest("opened", options));

			expect(response.status).toBe(200);
			expect(mocks.send).toHaveBeenCalledWith([
				expect.objectContaining({
					name: "preview/close-requested",
					data: expect.objectContaining({
						baseServiceId: "service-a",
						previewGitRef: "refs/pull/42/merge",
					}),
				}),
			]);
		},
	);

	it.each([
		["closed", true, "pull_request_merged"],
		["closed", false, "pull_request_closed"],
		["converted_to_draft", false, "converted_to_draft"],
	])(
		"queues teardown for %s even before a clone exists",
		async (action, merged, reason) => {
			mocks.queryResults.push([linkedService({ serviceId: "service-a" })]);

			const response = await POST(pullRequest(action, { merged }));

			expect(response.status).toBe(200);
			expect(mocks.send).toHaveBeenCalledWith([
				expect.objectContaining({
					name: "preview/close-requested",
					data: {
						baseServiceId: "service-a",
						previewGitRef: "refs/pull/42/merge",
						reason,
						verifyWithGitHub: true,
					},
				}),
			]);
		},
	);
});
