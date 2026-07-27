import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { deployments, rollouts } from "@/db/schema";
import { markDeploymentFailedRemoved } from "@/lib/deployment-status";
import { sendDeploymentFailureAlert } from "@/lib/email";
import {
	enqueueReconcileForAllOnlineServers,
	enqueueWork,
} from "@/lib/work-queue";

export async function handleRolloutFailure(
	rolloutId: string,
	serviceId: string,
	reason: string,
	isRollingUpdate: boolean,
): Promise<void> {
	const { applied, rolloutDeployments } = await db.transaction(async (tx) => {
		const [rollout] = await tx
			.select({ status: rollouts.status })
			.from(rollouts)
			.where(eq(rollouts.id, rolloutId))
			.for("update");
		if (rollout?.status !== "in_progress") {
			return { applied: false, rolloutDeployments: [] };
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
			return { applied: true, rolloutDeployments };
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

		return { applied: true, rolloutDeployments };
	});
	if (!applied) return;

	if (rolloutDeployments.length === 0) {
		sendDeploymentFailureAlert({
			serviceId,
			serverId: null,
			failedStage: reason,
		}).catch((error) => {
			console.error(
				"[rollout:failure] failed to send deployment failure alert:",
				error,
			);
		});
		return;
	}

	const serverId = rolloutDeployments[0].serverId;

	sendDeploymentFailureAlert({
		serviceId,
		serverId,
		failedStage: reason,
	}).catch((error) => {
		console.error(
			"[rollout:failure] failed to send deployment failure alert:",
			error,
		);
	});
}
