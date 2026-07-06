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
	});
});
