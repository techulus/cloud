import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	values: vi.fn(),
	onConflictDoNothing: vi.fn(),
	returning: vi.fn(),
	revisionRows: [] as unknown[],
	getTargetPlatformsForRevision: vi.fn(),
	selectBuildServerForRevision: vi.fn(),
	enqueueWork: vi.fn(),
	send: vi.fn(),
	createBuildStarted: vi.fn((data) => ({ name: "build/started", data })),
}));

vi.mock("@/db", () => ({
	db: {
		insert: vi.fn(() => ({ values: mocks.values })),
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => Promise.resolve(mocks.revisionRows)),
			})),
		})),
	},
}));
vi.mock("@/db/schema", () => ({
	builds: { id: "id" },
	serviceRevisions: {
		id: "id",
		serviceId: "service_id",
		specification: "specification",
	},
}));
vi.mock("@/lib/build-assignment", () => ({
	getTargetPlatformsForRevision: mocks.getTargetPlatformsForRevision,
	selectBuildServerForRevision: mocks.selectBuildServerForRevision,
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

function invoke(commitSha: string) {
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
				trigger: "manual",
				commitSha,
				commitMessage: "Exact source commit",
				branch: "main",
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
		mocks.revisionRows.push({
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
		mocks.returning.mockResolvedValue([{ id: "build-1" }, { id: "build-2" }]);
		mocks.getTargetPlatformsForRevision.mockResolvedValue([
			"linux/amd64",
			"linux/arm64",
		]);
		mocks.selectBuildServerForRevision.mockResolvedValue("server-1");
	});

	it("persists one immutable commit for every target platform", async () => {
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

	it("rejects a moving ref before creating any platform build", async () => {
		await expect(invoke("HEAD")).rejects.toThrow(
			"Build fan-out requires a full 40-character commit SHA",
		);

		expect(mocks.getTargetPlatformsForRevision).not.toHaveBeenCalled();
		expect(mocks.values).not.toHaveBeenCalled();
		expect(mocks.enqueueWork).not.toHaveBeenCalled();
	});
});
