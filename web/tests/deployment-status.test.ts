import { describe, expect, it } from "vitest";
import {
	dnsDeploymentStatuses,
	expectedDeploymentStatuses,
	routableDeploymentStatuses,
} from "@/lib/deployment-status";

describe("deployment status capabilities", () => {
	it("keeps sleeping deployments expected but unroutable", () => {
		expect(expectedDeploymentStatuses).toContain("sleeping");
		expect(routableDeploymentStatuses).not.toContain("sleeping");
		expect(dnsDeploymentStatuses).not.toContain("sleeping");
	});

	it("keeps waking deployments expected but unroutable", () => {
		expect(expectedDeploymentStatuses).toContain("waking");
		expect(routableDeploymentStatuses).not.toContain("waking");
		expect(dnsDeploymentStatuses).not.toContain("waking");
	});
});
