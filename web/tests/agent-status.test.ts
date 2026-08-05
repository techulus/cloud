import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const selectResults: unknown[][] = [];
	const updateData: unknown[] = [];

	function createQuery(result: unknown[] = []) {
		const query = {
			from: vi.fn(() => query),
			set: vi.fn((data: unknown) => {
				updateData.push(data);
				return query;
			}),
			where: vi.fn(() => query),
			returning: vi.fn(() => query),
			// oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are awaitable.
			then: (
				resolve: (value: unknown[]) => unknown,
				reject?: (reason: unknown) => unknown,
			) => Promise.resolve(result).then(resolve, reject),
		};

		return query;
	}

	return {
		selectResults,
		updateData,
		db: {
			select: vi.fn(() => createQuery(selectResults.shift() ?? [])),
			update: vi.fn(() => createQuery()),
			delete: vi.fn(() => createQuery()),
		},
	};
});

vi.mock("@/db", () => ({ db: mocks.db }));
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
	applyStatusReport,
	getSleepTransitionDeploymentIds,
	getStaleStoppedReportUpdate,
	getStoppedContainerReportUpdate,
	shouldAttachReportedContainer,
} from "@/lib/agent-status";
import { inngest } from "@/lib/inngest/client";

beforeEach(() => {
	mocks.selectResults.length = 0;
	mocks.updateData.length = 0;
	mocks.db.select.mockClear();
	mocks.db.update.mockClear();
	mocks.db.delete.mockClear();
});

describe("agent status CrowdSec health", () => {
	it("persists a supplied snapshot unchanged and preserves it when omitted", async () => {
		const crowdsecHealth = {
			checkedAt: "2026-08-04T12:00:00Z",
			lapi: { available: true },
			metrics: {
				available: true,
				reads: 120,
				parsed: 115,
				unparsed: 5,
			},
			bouncer: {
				available: true,
				registered: true,
				revoked: false,
				lastPullAt: "2026-08-04T11:59:00Z",
			},
			decisions: {
				available: true,
				truncated: false,
				records: [
					{
						scope: "Ip",
						value: "192.0.2.1",
						action: "ban",
						reason: "test-scenario",
						origin: "crowdsec",
						expiresAt: "2026-08-04T13:00:00Z",
					},
				],
			},
			alerts: {
				available: true,
				truncated: false,
				records: [
					{
						id: 42,
						detectedAt: "2026-08-04T11:58:00Z",
						scenario: "test-scenario",
						sourceIp: "192.0.2.1",
						country: "US",
						eventCount: 3,
					},
				],
			},
		};

		await applyStatusReport("server_1", { containers: [], crowdsecHealth });

		expect(mocks.updateData[0]).toEqual(
			expect.objectContaining({ crowdsecHealth }),
		);

		mocks.updateData.length = 0;
		await applyStatusReport("server_1", { containers: [] });

		expect(mocks.updateData[0]).not.toHaveProperty("crowdsecHealth");
	});
});

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

	it("restores stale stopped observations from live running reports", () => {
		expect(
			getStaleStoppedReportUpdate({
				hasHealthCheck: false,
				healthStatus: "none",
			}),
		).toEqual({
			observedPhase: "healthy",
			healthStatus: "none",
			serverlessWakeFailureCount: 0,
		});

		expect(
			getStaleStoppedReportUpdate({
				hasHealthCheck: true,
				healthStatus: "starting",
			}),
		).toEqual({
			observedPhase: "starting",
			healthStatus: "starting",
			serverlessWakeFailureCount: 0,
		});

		expect(
			getStaleStoppedReportUpdate({
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
					{
						type: "sleep",
						deploymentId: "dep_sleep",
						containerId: "ctr_sleep",
					},
					{ type: "wake_started", deploymentId: "dep_wake" },
					{ type: "sleep", deploymentId: "dep_missing_container" },
				]),
			),
		).toEqual(["dep_sleep"]);
	});
});

describe("agent status deployment cleanup", () => {
	it("deletes a removed containerless deployment missing from the report", async () => {
		mocks.selectResults.push([
			{
				id: "deployment_removed",
				containerId: null,
				runtimeDesiredState: "removed",
				observedPhase: "sleeping",
			},
		]);

		await applyStatusReport("server_1", { containers: [] });

		expect(mocks.db.delete).toHaveBeenCalledTimes(1);
	});

	it("retains a removed deployment whose container is reported in a transient state", async () => {
		const deployment = {
			id: "deployment_removed",
			serviceId: "service_1",
			serviceRevisionId: "revision_1",
			serverId: "server_1",
			containerId: "container_1",
			runtimeDesiredState: "removed",
			trafficState: "inactive",
			observedPhase: "sleeping",
			rolloutId: "rollout_1",
		};
		mocks.selectResults.push([deployment]);

		await applyStatusReport("server_1", {
			containers: [
				{
					deploymentId: deployment.id,
					containerId: "container_1",
					status: "transient",
					healthStatus: "none",
				},
			],
		});

		expect(mocks.db.delete).not.toHaveBeenCalled();
	});

	it("retains a removed containerless deployment that reappears in the report", async () => {
		const deployment = {
			id: "deployment_removed",
			serviceId: "service_1",
			serviceRevisionId: "revision_1",
			serverId: "server_1",
			containerId: null,
			runtimeDesiredState: "removed",
			trafficState: "inactive",
			observedPhase: "sleeping",
			rolloutId: "rollout_1",
		};
		mocks.selectResults.push([deployment], [deployment]);

		await applyStatusReport("server_1", {
			containers: [
				{
					deploymentId: deployment.id,
					containerId: "container_1",
					status: "running",
					healthStatus: "none",
				},
			],
		});

		expect(mocks.db.delete).not.toHaveBeenCalled();
	});
});

describe("agent status stopped-phase recovery", () => {
	it("promotes a non-serverless stopped deployment with a running container and notifies its rollout", async () => {
		const deployment = {
			id: "deployment_1",
			serviceId: "service_1",
			serviceRevisionId: "revision_1",
			serverId: "server_1",
			containerId: "container_1",
			runtimeDesiredState: "running",
			trafficState: "active",
			observedPhase: "stopped",
			rolloutId: "rollout_1",
		};
		mocks.selectResults.push(
			[deployment],
			[deployment],
			[
				{
					specification: { serverless: { enabled: false }, healthCheck: null },
				},
			],
		);

		await applyStatusReport("server_1", {
			containers: [
				{
					deploymentId: deployment.id,
					containerId: "container_1",
					status: "running",
					healthStatus: "none",
				},
			],
		});

		expect(inngest.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "deployment",
				id: "deployment_1",
				parentType: "rollout",
				parentId: "rollout_1",
			}),
		);
	});

	it("notifies the rollout when an unknown deployment is restored to running", async () => {
		const deployment = {
			id: "deployment_unknown",
			serviceId: "service_1",
			serviceRevisionId: "revision_1",
			serverId: "server_1",
			containerId: "container_1",
			runtimeDesiredState: "running",
			trafficState: "active",
			observedPhase: "unknown",
			rolloutId: "rollout_2",
		};
		mocks.selectResults.push([deployment], [deployment]);

		await applyStatusReport("server_1", {
			containers: [
				{
					deploymentId: deployment.id,
					containerId: "container_1",
					status: "running",
					healthStatus: "none",
				},
			],
		});

		expect(inngest.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "deployment",
				id: "deployment_unknown",
				parentType: "rollout",
				parentId: "rollout_2",
			}),
		);
	});
});
