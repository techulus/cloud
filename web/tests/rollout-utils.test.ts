import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/email", () => ({
	sendDeploymentFailureAlert: vi.fn(),
}));

import {
	shouldRestoreDrainingDeploymentAsSleeping,
	shouldRollBackDeploymentStatus,
} from "@/lib/inngest/functions/rollout-utils";

const deployedServerlessConfig = JSON.stringify({
	source: { type: "image", image: "nginx" },
	stateful: false,
	replicas: [],
	healthCheck: null,
	ports: [],
	serverless: {
		enabled: true,
		sleepAfterSeconds: 300,
		wakeTimeoutSeconds: 120,
		minReadyReplicas: 1,
	},
});

describe("rollout failure helpers", () => {
	it("cleans up sleeping and waking rollout deployments", () => {
		expect(shouldRollBackDeploymentStatus("sleeping")).toBe(true);
		expect(shouldRollBackDeploymentStatus("waking")).toBe(true);
		expect(shouldRollBackDeploymentStatus("running")).toBe(true);
		expect(shouldRollBackDeploymentStatus("draining")).toBe(false);
		expect(shouldRollBackDeploymentStatus("stopped")).toBe(false);
	});

	it("restores no-container deployed-serverless drains as sleeping", () => {
		const service = {
			serverlessEnabled: false,
			stateful: true,
			deployedConfig: deployedServerlessConfig,
		};

		expect(
			shouldRestoreDrainingDeploymentAsSleeping(
				{ containerId: null },
				service,
			),
		).toBe(true);
		expect(
			shouldRestoreDrainingDeploymentAsSleeping(
				{ containerId: "ctr_old" },
				service,
			),
		).toBe(false);
		expect(
			shouldRestoreDrainingDeploymentAsSleeping(
				{ containerId: null },
				{
					serverlessEnabled: false,
					stateful: false,
					deployedConfig: null,
				},
			),
		).toBe(false);
	});
});
