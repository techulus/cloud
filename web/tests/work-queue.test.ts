import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

import { buildRolloutReconcileWorkItem } from "@/lib/work-queue";

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
