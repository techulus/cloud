import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const queryResults: unknown[][] = [];

	function createQuery(result: unknown[]) {
		const query = {
			from: vi.fn(() => query),
			innerJoin: vi.fn(() => query),
			where: vi.fn(() => query),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
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
	},
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
}: {
	serviceId: string;
	name?: string;
	branch?: string;
	autoDeploy?: boolean;
	sourceType?: "github" | "image";
	deletedAt?: Date | null;
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
		},
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
	});

	it("queues every active service linked to the pushed repository and branch", async () => {
		mocks.queryResults.push(
			[
				linkedService({ serviceId: "service-a", name: "web" }),
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
		expect(mocks.send).toHaveBeenCalledTimes(2);
		expect(mocks.createBuildTrigger).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				serviceId: "service-a",
				githubRepoId: "link-service-a",
				githubDeploymentId: 1001,
			}),
			{ id: `github-push:link-service-a:${COMMIT_SHA}` },
		);
		expect(mocks.createBuildTrigger).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				serviceId: "service-b",
				githubRepoId: "link-service-b",
				githubDeploymentId: 1002,
			}),
			{ id: `github-push:link-service-b:${COMMIT_SHA}` },
		);
		expect(mocks.createGitHubDeployment).toHaveBeenNthCalledWith(
			1,
			123,
			"techulus/cloud",
			COMMIT_SHA,
			"web-service-a",
			expect.any(String),
		);
		expect(mocks.createGitHubDeployment).toHaveBeenNthCalledWith(
			2,
			123,
			"techulus/cloud",
			COMMIT_SHA,
			"web-service-b",
			expect.any(String),
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
		expect(mocks.send).toHaveBeenCalledTimes(1);
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
		expect(mocks.send).toHaveBeenCalledTimes(1);
		expect(mocks.createBuildTrigger).toHaveBeenCalledWith(
			expect.objectContaining({ serviceId: "service-eligible" }),
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
		mocks.send
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
		expect(mocks.send).toHaveBeenCalledTimes(3);
		expect(mocks.createBuildTrigger).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				serviceId: "service-deployment-error",
				githubDeploymentId: undefined,
			}),
			expect.any(Object),
		);
		expect(mocks.createBuildTrigger).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({ serviceId: "service-later" }),
			expect.any(Object),
		);
	});
});
