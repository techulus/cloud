import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const updateResults: unknown[][] = [];
	const selectResults: unknown[][] = [];
	function query(result: unknown[]) {
		const builder = {
			set: vi.fn(() => builder),
			from: vi.fn(() => builder),
			where: vi.fn(() => builder),
			returning: vi.fn(() => Promise.resolve(result)),
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable.
			then: (resolve: (value: unknown[]) => unknown) =>
				Promise.resolve(result).then(resolve),
		};
		return builder;
	}
	return {
		updateResults,
		selectResults,
		update: vi.fn(() => query(updateResults.shift() ?? [])),
		select: vi.fn(() => query(selectResults.shift() ?? [])),
		finalizeManifestBuild: vi.fn(),
		send: vi.fn(),
	};
});

vi.mock("@/db", () => ({
	db: { update: mocks.update, select: mocks.select },
}));
vi.mock("@/lib/manifest-finalization", () => ({
	finalizeManifestBuild: mocks.finalizeManifestBuild,
}));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		manifestCompleted: { create: vi.fn((data) => data) },
		manifestFailed: { create: vi.fn((data) => data) },
	},
}));

import {
	buildRolloutReconcileWorkItems,
	completeWorkItemResults,
} from "@/lib/work-queue";

const manifestItem = {
	id: "manifest-work-group-1",
	serverId: "server-1",
	type: "create_manifest",
	status: "completed",
	attempts: 2,
	payload: JSON.stringify({
		serviceId: "service-1",
		serviceRevisionId: "revision-1",
		buildGroupId: "group-1",
		finalImageUri: "registry/app:revision-1",
		images: ["registry/app:revision-1-amd64"],
	}),
};

describe("manifest completion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.updateResults.length = 0;
		mocks.selectResults.length = 0;
		mocks.finalizeManifestBuild.mockResolvedValue({
			status: "completed",
			deployment: { rolloutId: "rollout-1" },
		});
		mocks.send.mockResolvedValue(undefined);
	});

	it("retries manifest finalization without blocking later results", async () => {
		const laterItem = {
			...manifestItem,
			id: "reconcile-1",
			type: "reconcile",
		};
		mocks.updateResults.push([manifestItem], [laterItem]);
		mocks.finalizeManifestBuild.mockRejectedValueOnce(
			new Error("rollout event failed"),
		);

		await expect(
			completeWorkItemResults("server-1", [
				{ id: manifestItem.id, attempt: 2, status: "completed" },
				{ id: laterItem.id, attempt: 2, status: "completed" },
			]),
		).resolves.toEqual({ accepted: [laterItem.id], rejected: [] });

		mocks.updateResults.push([]);
		mocks.selectResults.push([manifestItem]);
		await expect(
			completeWorkItemResults("server-1", [
				{ id: manifestItem.id, attempt: 2, status: "completed" },
			]),
		).resolves.toEqual({ accepted: [manifestItem.id], rejected: [] });
		expect(mocks.finalizeManifestBuild).toHaveBeenCalledTimes(2);
	});

	it("does not retry a terminal manifest for a different attempt", async () => {
		mocks.updateResults.push([]);
		mocks.selectResults.push([], [manifestItem]);

		await expect(
			completeWorkItemResults("server-1", [
				{ id: manifestItem.id, attempt: 1, status: "completed" },
			]),
		).resolves.toEqual({
			accepted: [],
			rejected: [{ id: manifestItem.id, reason: "already_terminal" }],
		});
		expect(mocks.finalizeManifestBuild).not.toHaveBeenCalled();
	});
});

describe("rollout reconcile work", () => {
	it("builds one deterministic wire item per server", () => {
		expect(
			buildRolloutReconcileWorkItems({
				rolloutId: "rollout_1",
				stage: "deploy",
				serverIds: ["server_2", "server_1", "server_2"],
			}),
		).toEqual([
			{
				id: "reconcile:rollout_1:deploy:server_1",
				serverId: "server_1",
				type: "reconcile",
				payload: '{"reason":"rollout_deploy"}',
			},
			{
				id: "reconcile:rollout_1:deploy:server_2",
				serverId: "server_2",
				type: "reconcile",
				payload: '{"reason":"rollout_deploy"}',
			},
		]);
	});
});
