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
	buildRolloutReconcileWorkItem,
	classifyWorkType,
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

	it("propagates finalization failure and retries the same terminal result", async () => {
		mocks.updateResults.push([manifestItem]);
		mocks.finalizeManifestBuild.mockRejectedValueOnce(
			new Error("rollout event failed"),
		);

		await expect(
			completeWorkItemResults("server-1", [
				{ id: manifestItem.id, attempt: 2, status: "completed" },
			]),
		).rejects.toThrow("rollout event failed");

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

describe("work lanes", () => {
	it("classifies every work type into its agent execution lane", () => {
		expect(
			(["deploy", "reconcile", "stop", "restart"] as const).map(
				classifyWorkType,
			),
		).toEqual(["runtime", "runtime", "runtime", "runtime"]);
		expect(
			(["build", "create_manifest"] as const).map(classifyWorkType),
		).toEqual(["build", "build"]);
		expect(
			(
				[
					"force_cleanup",
					"cleanup_volumes",
					"backup_volume",
					"restore_volume",
					"upgrade_agent",
				] as const
			).map(classifyWorkType),
		).toEqual(Array(5).fill("exclusive"));
	});
});

describe("rollout reconcile work", () => {
	it("uses a deterministic identity per rollout, stage, and server", () => {
		const deploy = buildRolloutReconcileWorkItem({
			rolloutId: "rollout_1",
			stage: "deploy",
			serverId: "server_1",
		});

		expect(deploy).toEqual({
			id: "reconcile:rollout_1:deploy:server_1",
			serverId: "server_1",
			type: "reconcile",
			payload: JSON.stringify({ reason: "rollout_deploy" }),
		});
		expect(
			buildRolloutReconcileWorkItem({
				rolloutId: "rollout_1",
				stage: "routing",
				serverId: "server_1",
			}).id,
		).not.toBe(deploy.id);
		expect(
			buildRolloutReconcileWorkItem({
				rolloutId: "rollout_1",
				stage: "deploy",
				serverId: "server_2",
			}).id,
		).not.toBe(deploy.id);
	});
});
