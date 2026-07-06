import { describe, expect, it } from "vitest";
import { getServerlessWakeFailureUpdate } from "@/lib/serverless-wake-failures";

describe("serverless wake failure policy", () => {
	it("keeps enabled serverless deployments retryable below the failure limit", () => {
		expect(
			getServerlessWakeFailureUpdate({
				serverlessEnabled: true,
				currentFailureCount: 1,
				failedStage: "serverless_wake",
			}),
		).toMatchObject({
			runtimeDesiredState: "stopped",
			observedPhase: "sleeping",
			failedStage: null,
			serverlessWakeFailureCount: 2,
		});
	});

	it("parks enabled serverless deployments after repeated wake failures", () => {
		expect(
			getServerlessWakeFailureUpdate({
				serverlessEnabled: true,
				currentFailureCount: 2,
				failedStage: "serverless_wake",
			}),
		).toMatchObject({
			runtimeDesiredState: "removed",
			trafficState: "inactive",
			observedPhase: "failed",
			failedStage: "serverless_wake",
			serverlessWakeFailureCount: 3,
		});
	});

	it("fails disabled transition deployments immediately", () => {
		expect(
			getServerlessWakeFailureUpdate({
				serverlessEnabled: false,
				currentFailureCount: 0,
				failedStage: "serverless_wake_timeout",
			}),
		).toMatchObject({
			runtimeDesiredState: "removed",
			trafficState: "inactive",
			observedPhase: "failed",
			failedStage: "serverless_wake_timeout",
			serverlessWakeFailureCount: 1,
		});
	});
});
