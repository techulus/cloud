import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/inngest/client", () => ({
	inngest: { send: vi.fn() },
}));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		resourceStatusChanged: { create: vi.fn((payload) => payload) },
		serverDnsSynced: { create: vi.fn((payload) => payload) },
	},
}));
vi.mock("@/lib/victoria-logs", () => ({
	ingestRolloutLog: vi.fn(),
}));
vi.mock("@/lib/work-queue", () => ({
	enqueueWork: vi.fn(),
}));

import {
	getSleepTransitionDeploymentIds,
	getStaleStoppedServerlessReportUpdate,
	getStoppedContainerReportUpdate,
	shouldAttachReportedContainer,
} from "@/lib/agent-status";

describe("agent status serverless attachment", () => {
	it("does not attach reported containers to sleeping deployments", () => {
		expect(shouldAttachReportedContainer("pending")).toBe(true);
		expect(shouldAttachReportedContainer("pulling")).toBe(true);
		expect(shouldAttachReportedContainer("waking")).toBe(true);
		expect(shouldAttachReportedContainer("sleeping")).toBe(false);
		expect(shouldAttachReportedContainer("failed")).toBe(false);
	});

	it("preserves sleeping observation for intended-stopped container reports", () => {
		expect(
			getStoppedContainerReportUpdate({ runtimeDesiredState: "stopped" }),
		).toEqual({
			containerId: null,
			observedPhase: "sleeping",
			healthStatus: null,
		});

		expect(
			getStoppedContainerReportUpdate({ runtimeDesiredState: "running" }),
		).toEqual({
			observedPhase: "stopped",
			healthStatus: "none",
		});

		expect(
			getStoppedContainerReportUpdate({
				runtimeDesiredState: "running",
				observedPhase: "waking",
			}),
		).toEqual({
			observedPhase: "waking",
			healthStatus: null,
		});
	});

	it("restores stale stopped serverless observations from live running reports", () => {
		expect(
			getStaleStoppedServerlessReportUpdate({
				hasHealthCheck: false,
				healthStatus: "none",
			}),
		).toEqual({
			observedPhase: "healthy",
			healthStatus: "none",
			serverlessWakeFailureCount: 0,
		});

		expect(
			getStaleStoppedServerlessReportUpdate({
				hasHealthCheck: true,
				healthStatus: "starting",
			}),
		).toEqual({
			observedPhase: "starting",
			healthStatus: "starting",
			serverlessWakeFailureCount: 0,
		});

		expect(
			getStaleStoppedServerlessReportUpdate({
				hasHealthCheck: true,
				healthStatus: "healthy",
			}),
		).toEqual({
			observedPhase: "healthy",
			healthStatus: "healthy",
			serverlessWakeFailureCount: 0,
		});
	});

	it("extracts sleep transition ids without trusting raw payload shape", () => {
		expect(
			Array.from(
				getSleepTransitionDeploymentIds([
					null,
					42,
					{ type: "sleep", deploymentId: "", containerId: "ctr_empty" },
					{ type: "sleep", deploymentId: "dep_sleep", containerId: "ctr_sleep" },
					{ type: "wake_started", deploymentId: "dep_wake" },
					{ type: "sleep", deploymentId: "dep_missing_container" },
				]),
			),
		).toEqual(["dep_sleep"]);
	});
});
