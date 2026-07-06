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
	it("treats active traffic deployments as the live rollout version", () => {
		expect(
			isActiveDeploymentForRollout(
				{ trafficState: "active" },
				{ serverlessEnabled: true },
			),
		).toBe(true);
		expect(
			isActiveDeploymentForRollout(
				{ trafficState: "candidate" },
				{ serverlessEnabled: true },
			),
		).toBe(false);
		expect(
			isActiveDeploymentForRollout(
				{ trafficState: "draining" },
				{ serverlessEnabled: false },
			),
		).toBe(false);
	});
});
