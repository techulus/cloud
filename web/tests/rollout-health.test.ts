import { describe, expect, it } from "vitest";
import { summarizePlannedDeploymentHealth } from "@/lib/rollout-health";

describe("planned rollout deployment health", () => {
	it("fails when an initially ready deployment regresses", () => {
		const summary = summarizePlannedDeploymentHealth(
			["deployment_a", "deployment_b"],
			[
				{ id: "deployment_a", observedPhase: "failed" },
				{ id: "deployment_b", observedPhase: "healthy" },
			],
		);

		expect(summary.hasTerminalFailure).toBe(true);
		expect(summary.unresolvedDeploymentIds).toEqual(["deployment_a"]);
	});

	it("fails when any planned deployment disappears", () => {
		const summary = summarizePlannedDeploymentHealth(
			["deployment_a", "deployment_b"],
			[{ id: "deployment_b", observedPhase: "healthy" }],
		);

		expect(summary.hasTerminalFailure).toBe(true);
		expect(summary.missingDeploymentIds).toEqual(["deployment_a"]);
	});
});
