import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/queries", () => ({ getService: vi.fn() }));
vi.mock("@/lib/acme-manager", () => ({
	getCertificate: vi.fn(),
	issueCertificate: vi.fn(),
}));
vi.mock("@/lib/wireguard", () => ({
	assignContainerIp: vi.fn(),
}));
vi.mock("@/lib/work-queue", () => ({
	enqueueWork: vi.fn(),
}));

import { isActiveDeploymentForRollout } from "@/lib/inngest/functions/rollout-helpers";

describe("rollout helpers", () => {
	it("treats sleeping and waking serverless deployments as active rollout versions", () => {
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

		expect(
			isActiveDeploymentForRollout(
				{ status: "sleeping" },
				{ serverlessEnabled: true },
			),
		).toBe(true);
		expect(
			isActiveDeploymentForRollout(
				{ status: "waking" },
				{ serverlessEnabled: true },
			),
		).toBe(true);
		expect(
			isActiveDeploymentForRollout(
				{ status: "sleeping" },
				{
					serverlessEnabled: false,
					deployedConfig: deployedServerlessConfig,
				},
			),
		).toBe(true);
		expect(
			isActiveDeploymentForRollout(
				{ status: "sleeping" },
				{
					serverlessEnabled: false,
					deployedConfig: JSON.stringify({
						source: { type: "image", image: "nginx" },
						stateful: false,
						replicas: [],
						healthCheck: null,
						ports: [],
						serverless: {
							enabled: false,
							sleepAfterSeconds: 300,
							wakeTimeoutSeconds: 120,
							minReadyReplicas: 1,
						},
					}),
				},
			),
		).toBe(false);
		expect(
			isActiveDeploymentForRollout(
				{ status: "healthy" },
				{ serverlessEnabled: false },
			),
		).toBe(true);
	});
});
