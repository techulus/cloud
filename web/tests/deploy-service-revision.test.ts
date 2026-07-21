import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createRolloutForServiceRevision: vi.fn(),
	createRolloutWithServiceRevision: vi.fn(),
	getService: vi.fn(),
	replicaRows: [] as unknown[],
	startMigrationInternal: vi.fn(),
	triggerBuildInternal: vi.fn(),
	send: vi.fn(),
	createRolloutCreated: vi.fn((data, options) => ({
		name: "rollout/created",
		data,
		...options,
	})),
}));

vi.mock("@/db", () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => Promise.resolve(mocks.replicaRows)),
			})),
		})),
	},
}));
vi.mock("@/db/queries", () => ({ getService: mocks.getService }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/migrations", () => ({
	startMigrationInternal: mocks.startMigrationInternal,
}));
vi.mock("@/lib/service-revisions", () => ({
	createRolloutForServiceRevision: mocks.createRolloutForServiceRevision,
	createRolloutWithServiceRevision: mocks.createRolloutWithServiceRevision,
}));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/lib/trigger-build", () => ({
	triggerBuildInternal: mocks.triggerBuildInternal,
}));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		rolloutCreated: { create: mocks.createRolloutCreated },
	},
}));

import {
	deployServiceInternal,
	deployServiceRevisionInternal,
} from "@/lib/deploy-service";

describe("revision rollout idempotency", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.send.mockResolvedValue(undefined);
		mocks.replicaRows.length = 0;
		mocks.startMigrationInternal.mockResolvedValue(undefined);
		mocks.triggerBuildInternal.mockResolvedValue({
			buildId: null,
			status: "queued",
		});
		mocks.createRolloutWithServiceRevision.mockResolvedValue({
			rolloutId: "rollout-redeploy",
		});
		mocks.createRolloutForServiceRevision
			.mockResolvedValueOnce({
				rolloutId: "rollout-1",
				created: true,
				revision: { id: "revision-1" },
			})
			.mockResolvedValueOnce({
				rolloutId: "rollout-1",
				created: false,
				revision: { id: "revision-1" },
			});
	});

	it("uses one idempotent rollout event identity for duplicate completion", async () => {
		await deployServiceRevisionInternal(
			"service-1",
			"revision-1",
			"registry/app:revision-1",
		);
		await deployServiceRevisionInternal(
			"service-1",
			"revision-1",
			"registry/app:revision-1",
		);

		expect(mocks.createRolloutForServiceRevision).toHaveBeenCalledTimes(2);
		expect(mocks.createRolloutCreated).toHaveBeenCalledTimes(2);
		expect(mocks.createRolloutCreated).toHaveBeenNthCalledWith(
			1,
			{ rolloutId: "rollout-1", serviceId: "service-1" },
			{ id: "rollout-created-rollout-1" },
		);
		expect(mocks.createRolloutCreated).toHaveBeenNthCalledWith(
			2,
			{ rolloutId: "rollout-1", serviceId: "service-1" },
			{ id: "rollout-created-rollout-1" },
		);
		expect(mocks.send).toHaveBeenCalledTimes(2);
		expect(mocks.send.mock.calls[0]?.[0].id).toBe(
			mocks.send.mock.calls[1]?.[0].id,
		);
	});

	it("retries dispatch for an existing rollout after a transient send failure", async () => {
		mocks.send
			.mockRejectedValueOnce(new Error("temporary Inngest outage"))
			.mockResolvedValueOnce(undefined);

		await expect(
			deployServiceRevisionInternal(
				"service-1",
				"revision-1",
				"registry/app:revision-1",
			),
		).rejects.toThrow("temporary Inngest outage");
		await expect(
			deployServiceRevisionInternal(
				"service-1",
				"revision-1",
				"registry/app:revision-1",
			),
		).resolves.toEqual(
			expect.objectContaining({ rolloutId: "rollout-1", created: false }),
		);
		expect(mocks.send).toHaveBeenCalledTimes(2);
		expect(mocks.send.mock.calls[0]?.[0].id).toBe(
			mocks.send.mock.calls[1]?.[0].id,
		);
	});

	it("bases a GitHub redeployment on an explicit runtime revision", async () => {
		mocks.getService.mockResolvedValue({
			id: "service-1",
			sourceType: "github",
			stateful: false,
		});

		await deployServiceInternal(
			"service-1",
			{ type: "system" },
			{
				runtimeBaseRevisionId: "revision-active",
			},
		);

		expect(mocks.createRolloutWithServiceRevision).toHaveBeenCalledWith(
			"service-1",
			{ type: "system" },
			"revision-active",
		);
	});

	it("requires an explicit build or runtime base for a GitHub deployment", async () => {
		mocks.getService.mockResolvedValue({
			id: "service-1",
			sourceType: "github",
			stateful: false,
		});

		await expect(
			deployServiceInternal("service-1", { type: "system" }),
		).rejects.toThrow("GitHub deployment requires a build trigger");
		expect(mocks.createRolloutWithServiceRevision).not.toHaveBeenCalled();
	});

	it("delegates an ordinary GitHub deployment to the build flow", async () => {
		mocks.getService.mockResolvedValue({
			id: "service-1",
			sourceType: "github",
			stateful: false,
		});

		await deployServiceInternal(
			"service-1",
			{ type: "system" },
			{
				githubTrigger: "scheduled",
			},
		);

		expect(mocks.triggerBuildInternal).toHaveBeenCalledWith(
			"service-1",
			"scheduled",
			{ type: "system" },
		);
		expect(mocks.createRolloutWithServiceRevision).not.toHaveBeenCalled();
	});

	it("starts stateful migration before dispatching a GitHub build", async () => {
		mocks.getService.mockResolvedValue({
			id: "service-1",
			sourceType: "github",
			stateful: true,
			lockedServerId: "server-old",
			migrationStatus: null,
		});
		mocks.replicaRows.push({ serverId: "server-new", replicas: 1 });

		await expect(
			deployServiceInternal(
				"service-1",
				{ type: "system" },
				{
					githubTrigger: "manual",
				},
			),
		).resolves.toEqual({ migrationStarted: true });
		expect(mocks.startMigrationInternal).toHaveBeenCalledWith(
			"service-1",
			"server-new",
			{ type: "system" },
		);
		expect(mocks.triggerBuildInternal).not.toHaveBeenCalled();
	});

	it("keeps image service deployment behavior unchanged", async () => {
		mocks.getService.mockResolvedValue({
			id: "service-1",
			sourceType: "image",
			stateful: false,
		});

		await deployServiceInternal("service-1", { type: "system" });

		expect(mocks.createRolloutWithServiceRevision).toHaveBeenCalledWith(
			"service-1",
			{ type: "system" },
			undefined,
		);
	});
});
