import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	values: vi.fn(),
	onConflictDoNothing: vi.fn(),
	returning: vi.fn(),
	set: vi.fn(),
	updateWhere: vi.fn(),
	revisionRows: [] as unknown[],
	transactionSelectResults: [] as unknown[][],
	execute: vi.fn(),
	getTargetPlatformsForRevision: vi.fn(),
	selectBuildServerForRevision: vi.fn(),
	enqueueWork: vi.fn(),
	createPreviewGitHubDeployment: vi.fn(),
	send: vi.fn(),
	createBuildStarted: vi.fn((data) => ({ name: "build/started", data })),
}));

vi.mock("@/db", () => ({
	db: (() => {
		function query(rows: unknown[]) {
			const query = {
				from: vi.fn(() => query),
				innerJoin: vi.fn(() => query),
				where: vi.fn(() => query),
				orderBy: vi.fn(() => query),
				limit: vi.fn(() => query),
				for: vi.fn(() => query),
				// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
				then: (
					resolve: (rows: unknown[]) => unknown,
					reject?: (reason: unknown) => unknown,
				) => Promise.resolve(rows).then(resolve, reject),
			};
			return query;
		}
		const tx = {
			execute: mocks.execute,
			insert: vi.fn(() => ({ values: mocks.values })),
			update: vi.fn(() => ({ set: mocks.set })),
			select: vi.fn(() => query(mocks.transactionSelectResults.shift() ?? [])),
		};
		return {
			select: vi.fn(() => query(mocks.revisionRows)),
			transaction: vi.fn((operation: (transaction: typeof tx) => unknown) =>
				operation(tx),
			),
		};
	})(),
}));
vi.mock("@/db/schema", () => ({
	builds: {
		id: "id",
		serviceId: "service_id",
		serviceRevisionId: "service_revision_id",
		commitSha: "commit_sha",
		branch: "branch",
		targetPlatform: "target_platform",
		buildGroupId: "build_group_id",
		status: "status",
	},
	services: {
		id: "id",
		deletedAt: "deleted_at",
		previewGitRef: "preview_git_ref",
	},
	serviceRevisions: {
		id: "id",
		serviceId: "service_id",
		specification: "specification",
		createdAt: "created_at",
	},
}));
vi.mock("@/lib/build-assignment", () => ({
	getTargetPlatformsForRevision: mocks.getTargetPlatformsForRevision,
	selectBuildServerForRevision: mocks.selectBuildServerForRevision,
}));
vi.mock("@/lib/preview-deployments", () => ({
	createPreviewGitHubDeployment: mocks.createPreviewGitHubDeployment,
}));
vi.mock("@/lib/work-queue", () => ({ enqueueWork: mocks.enqueueWork }));
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
		buildTrigger: { name: "build/trigger" },
		buildStarted: { create: mocks.createBuildStarted },
	},
}));

import { buildTriggerWorkflow } from "@/lib/inngest/functions/build-trigger-workflow";

const exactSha = "0123456789ABCDEF0123456789ABCDEF01234567";

function invoke(commitSha: string, gitRef?: string) {
	const step = {
		run: vi.fn(async (_name: string, operation: () => Promise<unknown>) =>
			operation(),
		),
	};
	const handler = buildTriggerWorkflow as unknown as (input: {
		event: { data: Record<string, unknown> };
		step: typeof step;
	}) => Promise<unknown>;
	return handler({
		event: {
			data: {
				serviceId: "service-1",
				serviceRevisionId: "revision-1",
				buildRequestId: "request-1",
				trigger: gitRef ? "preview" : "manual",
				commitSha,
				commitMessage: "Exact source commit",
				branch: "main",
				gitRef,
				author: "octocat",
				actor: { type: "system" },
			},
		},
		step,
	});
}

describe("build trigger fan-out", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.revisionRows.length = 0;
		mocks.transactionSelectResults.length = 0;
		mocks.revisionRows.push({
			previewGitRef: null,
			specification: {
				schemaVersion: 2,
				image: "registry.example.com/service-1:revision-1",
				source: {
					type: "github",
					repository: "https://github.com/owner/repository",
					repositoryId: null,
					branch: "main",
					commitSha: exactSha.toLowerCase(),
					rootDir: null,
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
				placements: [],
				ports: [],
				secrets: [],
				volumes: [],
			},
		});
		mocks.values.mockReturnValue({
			onConflictDoNothing: mocks.onConflictDoNothing,
		});
		mocks.onConflictDoNothing.mockReturnValue({ returning: mocks.returning });
		mocks.set.mockReturnValue({ where: mocks.updateWhere });
		mocks.returning.mockResolvedValue([{ id: "build-1" }, { id: "build-2" }]);
		mocks.getTargetPlatformsForRevision.mockResolvedValue([
			"linux/amd64",
			"linux/arm64",
		]);
		mocks.selectBuildServerForRevision.mockResolvedValue("server-1");
	});

	it("persists one immutable commit for every target platform", async () => {
		mocks.transactionSelectResults.push([
			{ id: "build-1", status: "pending" },
			{ id: "build-2", status: "pending" },
		]);
		await invoke(exactSha);

		expect(mocks.values).toHaveBeenCalledTimes(1);
		const rows = mocks.values.mock.calls[0]?.[0];
		expect(
			rows.map((row: Record<string, unknown>) => ({
				commitSha: row.commitSha,
				serviceRevisionId: row.serviceRevisionId,
				buildGroupId: row.buildGroupId,
				targetPlatform: row.targetPlatform,
			})),
		).toEqual([
			{
				commitSha: exactSha.toLowerCase(),
				serviceRevisionId: "revision-1",
				buildGroupId: "request-1",
				targetPlatform: "linux/amd64",
			},
			{
				commitSha: exactSha.toLowerCase(),
				serviceRevisionId: "revision-1",
				buildGroupId: "request-1",
				targetPlatform: "linux/arm64",
			},
		]);
		expect(
			mocks.selectBuildServerForRevision.mock.invocationCallOrder[1],
		).toBeLessThan(mocks.values.mock.invocationCallOrder[0]);
		expect(mocks.enqueueWork).toHaveBeenCalledTimes(2);
	});

	it("does not persist work for a superseded preview revision", async () => {
		const previewGitRef = "refs/pull/42/merge";
		(mocks.revisionRows[0] as Record<string, unknown>).previewGitRef =
			previewGitRef;
		mocks.transactionSelectResults.push(
			[{ id: "service-1" }],
			[{ id: "newer-revision" }],
		);

		await expect(invoke(exactSha, previewGitRef)).resolves.toMatchObject({
			status: "cancelled",
			reason: "superseded_preview_revision",
		});
		expect(mocks.values).not.toHaveBeenCalled();
		expect(mocks.enqueueWork).not.toHaveBeenCalled();
		expect(mocks.createPreviewGitHubDeployment).not.toHaveBeenCalled();
	});

	it("cancels a preview superseded before agent work is enqueued", async () => {
		const previewGitRef = "refs/pull/42/merge";
		(mocks.revisionRows[0] as Record<string, unknown>).previewGitRef =
			previewGitRef;
		mocks.transactionSelectResults.push(
			[{ id: "service-1" }],
			[{ id: "revision-1" }],
			[{ id: "service-1" }],
			[{ id: "newer-revision" }],
		);

		await expect(invoke(exactSha, previewGitRef)).resolves.toMatchObject({
			status: "cancelled",
			reason: "superseded_preview_revision",
		});
		expect(mocks.values).toHaveBeenCalled();
		expect(mocks.set).toHaveBeenCalledWith(
			expect.objectContaining({ status: "cancelled" }),
		);
		expect(mocks.enqueueWork).not.toHaveBeenCalled();
		expect(mocks.createBuildStarted).not.toHaveBeenCalled();
	});

	it("does not enqueue agent work after a build is cancelled", async () => {
		const previewGitRef = "refs/pull/42/merge";
		(mocks.revisionRows[0] as Record<string, unknown>).previewGitRef =
			previewGitRef;
		mocks.transactionSelectResults.push(
			[{ id: "service-1" }],
			[{ id: "revision-1" }],
			[{ id: "service-1" }],
			[{ id: "revision-1" }],
			[
				{ id: "build-1", status: "cancelled" },
				{ id: "build-2", status: "pending" },
			],
		);

		await expect(invoke(exactSha, previewGitRef)).resolves.toMatchObject({
			status: "cancelled",
			reason: "build_cancelled_before_enqueue",
		});
		expect(mocks.set).toHaveBeenCalledWith(
			expect.objectContaining({ status: "cancelled" }),
		);
		expect(mocks.enqueueWork).not.toHaveBeenCalled();
		expect(mocks.createBuildStarted).not.toHaveBeenCalled();
	});

	it("rejects a moving ref before creating any platform build", async () => {
		await expect(invoke("HEAD")).rejects.toThrow(
			"Build fan-out requires a full 40-character commit SHA",
		);

		expect(mocks.getTargetPlatformsForRevision).not.toHaveBeenCalled();
		expect(mocks.values).not.toHaveBeenCalled();
		expect(mocks.enqueueWork).not.toHaveBeenCalled();
	});
});
