import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { deployments, rollouts, serviceRevisions, services } from "@/db/schema";
import {
	markDeploymentFailedRemoved,
	selectNewestRevisionId,
} from "@/lib/deployment-status";
import { sendDeploymentFailureAlert } from "@/lib/email";

export async function handleRolloutFailure(
	rolloutId: string,
	serviceId: string,
	reason: string,
	isRollingUpdate: boolean,
): Promise<void> {
	let serverId: string | null = null;
	let hasRolloutDeployments = false;
	let handled = false;

	await db.transaction(async (tx) => {
		const rollout = await tx
			.select({ status: rollouts.status })
			.from(rollouts)
			.where(eq(rollouts.id, rolloutId))
			.for("update")
			.then((rows) => rows[0]);

		if (
			!rollout ||
			(rollout.status !== "queued" && rollout.status !== "in_progress")
		) {
			return;
		}
		handled = true;

		const rolloutDeployments = await tx
			.select()
			.from(deployments)
			.where(eq(deployments.rolloutId, rolloutId));

		hasRolloutDeployments = rolloutDeployments.length > 0;
		serverId = rolloutDeployments[0]?.serverId ?? null;

		await tx
			.update(rollouts)
			.set({
				status: hasRolloutDeployments ? "rolled_back" : "failed",
				currentStage: reason,
				completedAt: new Date(),
			})
			.where(eq(rollouts.id, rolloutId));

		if (!hasRolloutDeployments) return;

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

		await tx
			.update(deployments)
			.set(markDeploymentFailedRemoved(reason))
			.where(
				and(
					eq(deployments.rolloutId, rolloutId),
					ne(deployments.runtimeDesiredState, "removed"),
				),
			);

		const activeRevisionRows = await tx
			.select({
				serviceRevisionId: deployments.serviceRevisionId,
				revisionNumber: serviceRevisions.revisionNumber,
			})
			.from(deployments)
			.innerJoin(
				serviceRevisions,
				eq(deployments.serviceRevisionId, serviceRevisions.id),
			)
			.where(
				and(
					eq(deployments.serviceId, serviceId),
					eq(deployments.trafficState, "active"),
					ne(deployments.runtimeDesiredState, "removed"),
				),
			);
		const activeRevisionCount = new Set(
			activeRevisionRows.map((row) => row.serviceRevisionId),
		).size;
		if (activeRevisionCount > 1) {
			console.error(
				`[rollout:${rolloutId}] rollback found ${activeRevisionCount} active revisions for ${serviceId}; selecting the newest`,
			);
		}
		await tx
			.update(services)
			.set({ activeRevisionId: selectNewestRevisionId(activeRevisionRows) })
			.where(eq(services.id, serviceId));
	});

	if (!handled) return;

	if (!hasRolloutDeployments) {
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
