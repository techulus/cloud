import { describe, expect, it, vi } from "vitest";

type ServeOptions = {
	functions: unknown[];
};

const mocks = vi.hoisted(() => {
	const functions = {
		agentUpgradeTimeoutCheck: { id: "agent-upgrade-timeout-check" },
		backupWorkflow: { id: "backup-workflow" },
		buildTriggerWorkflow: { id: "build-trigger-workflow" },
		buildWorkflow: { id: "build-workflow" },
		certificateRenewal: { id: "certificate-renewal" },
		challengeCleanup: { id: "challenge-cleanup" },
		controlPlaneUpdateCheck: { id: "control-plane-update-check" },
		expiredDeletedServicesPurge: { id: "expired-deleted-services-purge" },
		migrationWorkflow: { id: "migration-workflow" },
		oldBackupsCleanup: { id: "old-backups-cleanup" },
		onDeploymentFailed: { id: "on-deployment-failed" },
		onRestoreFailed: { id: "on-restore-failed" },
		restoreTriggerWorkflow: { id: "restore-trigger-workflow" },
		restoreWorkflow: { id: "restore-workflow" },
		registryArtifactRetention: { id: "registry-artifact-retention" },
		rolloutWorkflow: { id: "rollout-workflow" },
		scheduledBackupsCheck: { id: "scheduled-backups-check" },
		scheduledDeploymentsCheck: { id: "scheduled-deployments-check" },
		serviceDeletionWorkflow: { id: "service-deletion-workflow" },
		serviceRestoreWorkflow: { id: "service-restore-workflow" },
		staleItemsCleanup: { id: "stale-items-cleanup" },
		staleServerCheck: { id: "stale-server-check" },
	};

	return {
		functions,
		serve: vi.fn((_options: ServeOptions) => ({
			GET: vi.fn(),
			POST: vi.fn(),
			PUT: vi.fn(),
		})),
	};
});

vi.mock("inngest/next", () => ({ serve: mocks.serve }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { id: "test" } }));
vi.mock("@/lib/inngest/functions", () => mocks.functions);

import "@/app/api/inngest/route";

describe("Inngest route", () => {
	it("registers every configured function", () => {
		expect(mocks.serve).toHaveBeenCalledOnce();
		const options = mocks.serve.mock.calls[0]?.[0];

		expect(options?.functions).toEqual(
			expect.arrayContaining(Object.values(mocks.functions)),
		);
		expect(options?.functions).toHaveLength(
			Object.keys(mocks.functions).length,
		);
	});
});
