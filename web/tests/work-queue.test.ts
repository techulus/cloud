import { describe, expect, it } from "vitest";
import { buildRolloutReconcileWorkItems } from "@/lib/work-queue";

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
