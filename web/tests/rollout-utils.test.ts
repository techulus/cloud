import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/email", () => ({
	sendDeploymentFailureAlert: vi.fn(),
}));

import {
	shouldRestoreDrainingDeployment,
	shouldRollBackDeploymentState,
} from "@/lib/inngest/functions/rollout-utils";

describe("rollout failure helpers", () => {
	it("cleans up live rollout deployments even after DNS promotion", () => {
		expect(
			shouldRollBackDeploymentState({
				trafficState: "candidate",
				runtimeDesiredState: "running",
			}),
		).toBe(true);
		expect(
			shouldRollBackDeploymentState({
				trafficState: "active",
				runtimeDesiredState: "running",
			}),
		).toBe(true);
		expect(
			shouldRollBackDeploymentState({
				trafficState: "candidate",
				runtimeDesiredState: "removed",
			}),
		).toBe(false);
	});

	it("restores draining deployments by traffic intent only", () => {
		expect(
			shouldRestoreDrainingDeployment({
				trafficState: "draining",
				runtimeDesiredState: "running",
			}),
		).toBe(true);
		expect(
			shouldRestoreDrainingDeployment({
				trafficState: "draining",
				runtimeDesiredState: "stopped",
			}),
		).toBe(true);
		expect(
			shouldRestoreDrainingDeployment({
				trafficState: "draining",
				runtimeDesiredState: "removed",
			}),
		).toBe(false);
	});
});
