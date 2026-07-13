import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/queries", () => ({ getService: vi.fn() }));
vi.mock("@/lib/acme-manager", () => ({
	getCertificate: vi.fn(),
	issueCertificate: vi.fn(),
}));
vi.mock("@/lib/wireguard", () => ({
	findAvailableContainerIp: vi.fn(),
}));
vi.mock("@/lib/work-queue", () => ({
	enqueueWork: vi.fn(),
}));

import {
	findAvailableHostPorts,
	isActiveDeploymentForRollout,
} from "@/lib/inngest/functions/rollout-helpers";

describe("rollout helpers", () => {
	it("treats active traffic deployments as the live rollout version", () => {
		expect(isActiveDeploymentForRollout({ trafficState: "active" })).toBe(true);
		expect(isActiveDeploymentForRollout({ trafficState: "candidate" })).toBe(
			false,
		);
		expect(isActiveDeploymentForRollout({ trafficState: "draining" })).toBe(
			false,
		);
	});

	it("allocates host ports around ports already in use", () => {
		expect(findAvailableHostPorts([30000, 30002], 3)).toEqual([
			30001, 30003, 30004,
		]);
	});
});
