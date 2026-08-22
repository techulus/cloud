import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	function updateQuery() {
		const query = {
			set: vi.fn(() => query),
			where: vi.fn(async () => undefined),
		};
		return query;
	}

	return {
		update: vi.fn(updateQuery),
		issueCertificatesForRevision: vi.fn(),
		handleRolloutFailure: vi.fn(),
		ingestRolloutLog: vi.fn(),
	};
});

vi.mock("@/db", () => ({ db: { update: mocks.update } }));
vi.mock("@/db/queries", () => ({ getService: vi.fn() }));
vi.mock("@/lib/deployment-status", () => ({
	isObservedReady: vi.fn(),
	observedReadyPhases: [],
}));
vi.mock("@/lib/preview-deployments", () => ({
	canDeployServiceRevision: vi.fn(),
	updatePreviewGitHubStatus: vi.fn(),
}));
vi.mock("@/lib/routing-sync", () => ({ buildRoutingTargets: vi.fn() }));
vi.mock("@/lib/service-revisions", () => ({
	getRolloutServiceRevision: vi.fn(),
}));
vi.mock("@/lib/victoria-logs", () => ({
	ingestRolloutLog: mocks.ingestRolloutLog,
}));
vi.mock("@/lib/work-queue", () => ({
	enqueueReconcileForAllOnlineServers: vi.fn(),
}));
vi.mock("@/lib/inngest/client", () => ({
	inngest: {
		createFunction: vi.fn(
			(_options: unknown, handler: (input: unknown) => unknown) => handler,
		),
	},
}));
vi.mock("@/lib/inngest/events", () => ({
	inngestEvents: {
		rolloutCreated: { name: "rollout/created" },
		rolloutCancelled: { name: "rollout/cancelled" },
		resourceStatusChanged: { name: "resource/status.changed" },
		serverDnsSynced: { name: "server/dns.synced" },
	},
}));
vi.mock("@/lib/inngest/functions/rollout-helpers", () => ({
	checkForRollingUpdate: vi.fn(),
	cleanupExistingDeployments: vi.fn(),
	cleanupTerminalDeployments: vi.fn(),
	completeRollout: vi.fn(),
	createDeploymentRecords: vi.fn(),
	issueCertificatesForRevision: mocks.issueCertificatesForRevision,
	resolveRevisionPlacements: vi.fn(),
	validateServers: vi.fn(),
}));
vi.mock("@/lib/inngest/functions/rollout-utils", () => ({
	handleRolloutFailure: mocks.handleRolloutFailure,
}));

import { rolloutWorkflow } from "@/lib/inngest/functions/rollout-workflow";

function invokeRollout() {
	const step = {
		run: vi.fn(async (name: string, operation: () => unknown) => {
			if (
				name.startsWith("issue-certificates-") ||
				name === "handle-certificate-failure"
			) {
				return operation();
			}

			switch (name) {
				case "validate-service":
					return false;
				case "acquire-rollout-turn-0":
					return "acquired";
				case "load-service-revision":
					return {
						id: "revision-1",
						specification: {
							ports: [],
							serverless: { enabled: false },
						},
					};
				case "log-rollout-started":
					return undefined;
				case "load-placements":
					return {
						success: true,
						placements: [{ serverId: "server-1", replicas: 1 }],
						totalReplicas: 1,
					};
				case "validate-servers":
					return { success: true, serverIds: ["server-1"] };
				case "cleanup-terminal-deployments":
					return undefined;
				case "check-rolling-update":
					return false;
				case "cleanup-existing":
					return undefined;
				case "create-deployments":
					throw new Error("continued after certificates");
				default:
					throw new Error(`unexpected step: ${name}`);
			}
		}),
		sleep: vi.fn(async () => undefined),
		waitForEvent: vi.fn(),
	};
	const handler = rolloutWorkflow as unknown as (input: {
		event: { data: { rolloutId: string; serviceId: string } };
		step: typeof step;
	}) => Promise<unknown>;

	return {
		result: handler({
			event: {
				data: { rolloutId: "rollout-1", serviceId: "service-1" },
			},
			step,
		}),
		step,
	};
}

describe("rollout certificate retries", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses durable backoff and continues after a later attempt succeeds", async () => {
		mocks.issueCertificatesForRevision
			.mockRejectedValueOnce(new Error("first outage"))
			.mockRejectedValueOnce(new Error("second outage"))
			.mockResolvedValueOnce({ issuedDomains: [] });

		const { result, step } = invokeRollout();

		await expect(result).rejects.toThrow("continued after certificates");
		expect(mocks.issueCertificatesForRevision).toHaveBeenCalledTimes(3);
		expect(step.sleep).toHaveBeenNthCalledWith(
			1,
			"wait-for-certificate-retry-1",
			"10s",
		);
		expect(step.sleep).toHaveBeenNthCalledWith(
			2,
			"wait-for-certificate-retry-2",
			"20s",
		);
		expect(step.run).toHaveBeenCalledWith(
			"create-deployments",
			expect.any(Function),
		);
		expect(mocks.handleRolloutFailure).not.toHaveBeenCalled();
	});

	it("uses the existing failure path once after three failed attempts", async () => {
		mocks.issueCertificatesForRevision
			.mockRejectedValueOnce(new Error("first outage"))
			.mockRejectedValueOnce(new Error("second outage"))
			.mockRejectedValueOnce(new Error("final outage"));

		const { result, step } = invokeRollout();

		await expect(result).resolves.toEqual({
			status: "failed",
			reason: "final outage",
		});
		expect(mocks.issueCertificatesForRevision).toHaveBeenCalledTimes(3);
		expect(step.sleep).toHaveBeenCalledTimes(2);
		expect(mocks.handleRolloutFailure).toHaveBeenCalledOnce();
		expect(mocks.handleRolloutFailure).toHaveBeenCalledWith(
			"rollout-1",
			"service-1",
			"certificate_provisioning_failed",
			false,
		);
	});
});
