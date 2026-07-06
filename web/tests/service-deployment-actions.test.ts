import { describe, expect, it } from "vitest";
import { getServiceDeploymentActionState } from "@/lib/service-deployment-actions";

describe("service deployment action state", () => {
	it("shows redeploy actions for sleeping serverless deployments", () => {
		const state = getServiceDeploymentActionState({
			configuredReplicas: [{ serverId: "proxy_1", count: 1 }],
			deployments: [
				{
					runtimeDesiredState: "stopped",
					observedPhase: "sleeping",
					containerId: null,
				},
			],
		} as any);

		expect(state).toMatchObject({
			hasDeployments: true,
			hasExpectedDeployments: true,
			hasRestartableDeployments: false,
			canStartAll: false,
		});
	});

	it("only shows restart when a running-intent deployment has a ready container", () => {
		const state = getServiceDeploymentActionState({
			configuredReplicas: [{ serverId: "proxy_1", count: 1 }],
			deployments: [
				{
					runtimeDesiredState: "running",
					observedPhase: "healthy",
					containerId: "container_1",
				},
			],
		} as any);

		expect(state).toMatchObject({
			hasExpectedDeployments: true,
			hasRestartableDeployments: true,
			canStartAll: false,
		});
	});

	it("shows start actions after deployments have been removed", () => {
		const state = getServiceDeploymentActionState({
			configuredReplicas: [{ serverId: "proxy_1", count: 1 }],
			deployments: [
				{
					runtimeDesiredState: "removed",
					observedPhase: "stopped",
					containerId: null,
				},
			],
		} as any);

		expect(state).toMatchObject({
			hasDeployments: true,
			hasExpectedDeployments: false,
			hasRestartableDeployments: false,
			canStartAll: true,
		});
	});
});
