import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { deployments, rollouts, servers } from "@/db/schema";
import { bumpAgentGeneration } from "@/lib/agent-generation";
import { markDeploymentFailedRemoved } from "@/lib/deployment-status";
import { sendDeploymentFailureAlert } from "@/lib/email";
import { recordRolloutStageBoundary } from "@/lib/rollout-timeline";
import { enqueueRolloutReconcile } from "@/lib/work-queue";

export async function restoreDrainingDeploymentsForRollback(serviceId: string) {
	await db.transaction(async (tx) => {
		const restored = await tx
			.update(deployments)
			.set({ trafficState: "active" })
			.where(
				and(
					eq(deployments.serviceId, serviceId),
					eq(deployments.trafficState, "draining"),
				),
			)
			.returning({ id: deployments.id });
		if (restored.length === 0) return;
		const recipients = await tx.select({ id: servers.id }).from(servers);
		for (const recipient of recipients) {
			await bumpAgentGeneration(tx, recipient.id);
		}
	});
}

export async function handleRolloutFailure(
	rolloutId: string,
	serviceId: string,
	reason: string,
	isRollingUpdate: boolean,
): Promise<void> {
	const affectedServerIds = await db.transaction(async (tx) => {
		const rolloutDeployments = await tx
			.select({ serverId: deployments.serverId })
			.from(deployments)
			.where(eq(deployments.rolloutId, rolloutId));
		await tx
			.select({ id: rollouts.id })
			.from(rollouts)
			.where(eq(rollouts.id, rolloutId))
			.for("update");
		await tx
			.update(rollouts)
			.set({
				status: rolloutDeployments.length === 0 ? "failed" : "rolled_back",
				currentStage: reason,
				completedAt: new Date(),
			})
			.where(eq(rollouts.id, rolloutId));
		await recordRolloutStageBoundary(tx, { rolloutId, stage: "failed" });

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
		const removed = await tx
			.update(deployments)
			.set(markDeploymentFailedRemoved(reason))
			.where(
				and(
					eq(deployments.rolloutId, rolloutId),
					ne(deployments.runtimeDesiredState, "removed"),
				),
			)
			.returning({ serverId: deployments.serverId });
		if (isRollingUpdate || removed.length > 0) {
			const recipients = await tx.select({ id: servers.id }).from(servers);
			for (const recipient of recipients) {
				await bumpAgentGeneration(tx, recipient.id);
			}
		}
		return {
			rolloutDeployments,
			serverIds: [...new Set(removed.map((deployment) => deployment.serverId))],
		};
	});

	if (affectedServerIds.rolloutDeployments.length === 0) {
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

	const serverId = affectedServerIds.rolloutDeployments[0].serverId;
	await enqueueRolloutReconcile(
		rolloutId,
		"cleanup",
		affectedServerIds.serverIds,
	);

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
