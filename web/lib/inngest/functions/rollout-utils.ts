import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { deployments, rollouts } from "@/db/schema";
import { markDeploymentFailedRemoved } from "@/lib/deployment-status";
import { notify } from "@/lib/notifications";
import { updatePreviewGitHubStatus } from "@/lib/preview-deployments";
import { reportBusinessFailure, reportServerError } from "@/lib/server-errors";
import {
	enqueueReconcileForAllOnlineServers,
	enqueueWork,
} from "@/lib/work-queue";

type RolloutFailureStage =
	| "workflow_failed"
	| "preflight_failed"
	| "certificate_provisioning_failed"
	| "deployment_failed"
	| "health_check_failed"
	| "health_check_timeout"
	| "dns_sync_timeout";

type RolloutFailureOptions = {
	rolloutId: string;
	serviceId: string;
	reason: string;
	failureStage: RolloutFailureStage;
	isRollingUpdate: boolean;
	report?: boolean;
};

export async function handleRolloutFailure({
	rolloutId,
	serviceId,
	reason,
	failureStage,
	isRollingUpdate,
	report = true,
}: RolloutFailureOptions): Promise<void> {
	const result = await db.transaction(async (tx) => {
		const [rollout] = await tx
			.select({
				status: rollouts.status,
				serviceRevisionId: rollouts.serviceRevisionId,
			})
			.from(rollouts)
			.where(eq(rollouts.id, rolloutId))
			.for("update");
		if (rollout?.status !== "in_progress") {
			return { applied: false as const, rolloutDeployments: [] };
		}

		const rolloutDeployments = await tx
			.select()
			.from(deployments)
			.where(eq(deployments.rolloutId, rolloutId));
		await tx
			.update(rollouts)
			.set({
				status: rolloutDeployments.length === 0 ? "failed" : "rolled_back",
				currentStage: reason,
				completedAt: new Date(),
			})
			.where(eq(rollouts.id, rolloutId));

		if (rolloutDeployments.length === 0) {
			return { applied: true as const, rolloutDeployments, rollout };
		}

		if (isRollingUpdate) {
			await tx
				.update(deployments)
				.set({ trafficState: "active" })
				.where(
					and(
						eq(deployments.serviceId, serviceId),
						eq(deployments.trafficState, "draining"),
					),
				);
		}

		const removedDeployments = await tx
			.update(deployments)
			.set(markDeploymentFailedRemoved(reason))
			.where(
				and(
					eq(deployments.rolloutId, rolloutId),
					ne(deployments.runtimeDesiredState, "removed"),
				),
			)
			.returning({ serverId: deployments.serverId });

		if (isRollingUpdate) {
			await enqueueReconcileForAllOnlineServers("rollout_rolled_back", tx);
		} else {
			for (const serverId of new Set(
				removedDeployments.map((deployment) => deployment.serverId),
			)) {
				await enqueueWork(
					serverId,
					"reconcile",
					{ reason: "rollout_rolled_back" },
					{ tx },
				);
			}
		}

		return { applied: true as const, rolloutDeployments, rollout };
	});
	if (!result.applied) return;
	const { rolloutDeployments } = result;
	const serviceRevisionId = result.rollout.serviceRevisionId;
	if (report) {
		reportBusinessFailure("rollout.failed", {
			occurrenceId: rolloutId,
			reason: failureStage,
			tags: {
				rolloutId,
				serviceId,
				...(serviceRevisionId ? { revisionId: serviceRevisionId } : {}),
				failureStage,
				rollbackState:
					rolloutDeployments.length === 0 ? "failed" : "rolled_back",
			},
		});
	}
	if (serviceRevisionId) {
		try {
			await updatePreviewGitHubStatus({
				serviceId,
				serviceRevisionId,
				state: "failure",
				description: `Preview rollout failed: ${reason}`,
			});
		} catch (error) {
			reportServerError(error, "rollout.preview-status.update", {
				tags: { rolloutId, serviceId, revisionId: serviceRevisionId },
			});
			console.error(
				"[rollout:failure] failed to update preview status:",
				error,
			);
		}
	}

	if (rolloutDeployments.length === 0) {
		notify({
			kind: "deployment.failed",
			occurrenceId: rolloutId,
			serviceId,
			serverId: null,
			failedStage: reason,
		}).catch((error) => {
			reportServerError(error, "rollout.failure.notification", {
				tags: { rolloutId, serviceId },
			});
			console.error(
				"[rollout:failure] failed to enqueue deployment failure notification:",
				error,
			);
		});
		return;
	}

	const serverId = rolloutDeployments[0].serverId;

	notify({
		kind: "deployment.failed",
		occurrenceId: rolloutId,
		serviceId,
		serverId,
		failedStage: reason,
	}).catch((error) => {
		reportServerError(error, "rollout.failure.notification", {
			tags: { rolloutId, serviceId, serverId },
		});
		console.error(
			"[rollout:failure] failed to enqueue deployment failure notification:",
			error,
		);
	});
}
