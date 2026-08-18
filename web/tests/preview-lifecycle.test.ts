import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { services } from "@/db/schema";

const mocks = vi.hoisted(() => {
	function query(result: unknown[]) {
		const value = {
			from: vi.fn(() => value),
			where: vi.fn(() => value),
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
			then: (
				resolve: (rows: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};
		return value;
	}
	function mutation(returning: unknown[] = []) {
		const value = {
			set: vi.fn(() => value),
			where: vi.fn(() => value),
			returning: vi.fn(() => Promise.resolve(returning)),
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
			then: (
				resolve: (result: undefined) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(undefined).then(resolve, reject),
		};
		return value;
	}

	const txSelectResults: unknown[][] = [];
	const dbSelectResults: unknown[][] = [];
	const tx = {
		execute: vi.fn().mockResolvedValue(undefined),
		select: vi.fn(() => query(txSelectResults.shift() ?? [])),
		update: vi.fn(() => mutation()),
	};
	const db = {
		transaction: vi.fn((operation: (transaction: typeof tx) => unknown) =>
			operation(tx),
		),
		select: vi.fn(() => query(dbSelectResults.shift() ?? [])),
		update: vi.fn(() => mutation()),
		delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
	};
	return {
		txSelectResults,
		dbSelectResults,
		db,
		prepareRegistryArtifactCleanup: vi.fn(),
		cleanupRegistryArtifactsForService: vi.fn(),
		inactivatePreviewGitHubDeployments: vi.fn(),
		enqueueReconcileForAllOnlineServers: vi.fn(),
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
vi.mock("@/lib/inngest/client", () => ({
	inngest: { send: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		buildCancelled: { create: vi.fn() },
		rolloutCancelled: { create: vi.fn() },
	},
}));
vi.mock("@/lib/preview-deployments", () => ({
	inactivatePreviewGitHubDeployments: mocks.inactivatePreviewGitHubDeployments,
}));
vi.mock("@/lib/registry-retention", () => ({
	prepareRegistryArtifactCleanup: mocks.prepareRegistryArtifactCleanup,
	cleanupRegistryArtifactsForService: mocks.cleanupRegistryArtifactsForService,
}));
vi.mock("@/lib/work-queue", () => ({
	enqueueReconcileForAllOnlineServers:
		mocks.enqueueReconcileForAllOnlineServers,
	enqueueWork: vi.fn(),
}));

import { deletePreviewService } from "@/lib/preview-lifecycle";

describe("preview deletion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.txSelectResults.length = 0;
		mocks.dbSelectResults.length = 0;
		mocks.prepareRegistryArtifactCleanup.mockResolvedValue(true);
		mocks.cleanupRegistryArtifactsForService.mockResolvedValue(undefined);
	});
	afterEach(() => vi.restoreAllMocks());

	it("hard-deletes the service when GitHub inactivation fails", async () => {
		mocks.txSelectResults.push([{ service: { id: "preview-service" } }]);
		mocks.dbSelectResults.push([]);
		mocks.inactivatePreviewGitHubDeployments.mockRejectedValue(
			new Error("GitHub unavailable"),
		);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await expect(
			deletePreviewService(
				"base-service",
				"refs/pull/42/merge",
				"pull request closed",
			),
		).resolves.toMatchObject({ service: { id: "preview-service" } });
		expect(mocks.db.delete).toHaveBeenCalledTimes(2);
		expect(mocks.db.delete).toHaveBeenLastCalledWith(services);
		expect(consoleError).toHaveBeenCalledWith(
			"[preview-lifecycle] failed to inactivate GitHub deployments for preview-service:",
			expect.any(Error),
		);
	});
});
