import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/queries", () => ({ getService: vi.fn() }));
vi.mock("@/lib/acme-manager", () => ({
	getCertificate: vi.fn(),
	issueCertificate: vi.fn(),
}));
vi.mock("@/lib/service-config", () => ({
	buildCurrentConfig: vi.fn(),
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
				{ serverlessEnabled: false },
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
