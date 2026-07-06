import { describe, expect, it } from "vitest";
import {
	getStartingHealthCheckFailureUpdate,
	getSteadyStateRecreateDecision,
} from "@/lib/autoheal-policy";

describe("autoheal policy", () => {
	it("keeps steady-state failed deployments desired until recreate limit", () => {
		const decision = getStartingHealthCheckFailureUpdate({
			isRolloutDeployment: false,
			recreateCount: 2,
		});

		expect(decision.recreateLimitReached).toBe(false);
		expect(decision.update).toMatchObject({
			observedPhase: "failed",
			runtimeDesiredState: "running",
			trafficState: "active",
			failedStage: "autoheal_recreate",
			autohealRecreateCount: 3,
		});
	});

	it("marks failed deployments undesired after recreate limit", () => {
		const decision = getStartingHealthCheckFailureUpdate({
			isRolloutDeployment: false,
			recreateCount: 3,
		});

		expect(decision.recreateLimitReached).toBe(true);
		expect(decision.update).toMatchObject({
			observedPhase: "failed",
			runtimeDesiredState: "removed",
			trafficState: "inactive",
			failedStage: "autoheal_recreate_limit",
			autohealRecreateCount: 3,
		});
	});

	it("marks rollout health-check failures undesired immediately", () => {
		const decision = getStartingHealthCheckFailureUpdate({
			isRolloutDeployment: true,
			recreateCount: 0,
		});

		expect(decision.update).toEqual({
			observedPhase: "failed",
			runtimeDesiredState: "removed",
			trafficState: "inactive",
			failedStage: "health_check",
		});
	});

	it("builds cleanup payload while steady-state recreate attempts remain", () => {
		const decision = getSteadyStateRecreateDecision({
			deployment: {
				id: "dep_1",
				serviceId: "svc_1",
				autohealRecreateCount: 1,
			},
			containerId: "container_1",
		} as Parameters<typeof getSteadyStateRecreateDecision>[0]);

		expect(decision.limitReached).toBe(false);
		expect(decision.updateFields).toMatchObject({
			observedPhase: "failed",
			runtimeDesiredState: "running",
			trafficState: "active",
			failedStage: "autoheal_recreate",
			autohealRecreateCount: 2,
		});
		expect(decision.cleanupPayload).toEqual({
			reason: "autoheal_recreate",
			deploymentId: "dep_1",
			serviceId: "svc_1",
			containerIds: ["container_1"],
		});
	});
});
