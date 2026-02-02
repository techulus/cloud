import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { deployments, rollouts } from "@/db/schema";
import { sendDeploymentFailureAlert } from "@/lib/email";

export async function handleRolloutFailure(
	rolloutId: string,
	serviceId: string,
	reason: string,
	isRollingUpdate: boolean,
): Promise<void> {
	const rolloutDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.rolloutId, rolloutId));

	if (rolloutDeployments.length === 0) return;

	const serverId = rolloutDeployments[0].serverId;

	if (isRollingUpdate) {
		await db
			.update(deployments)
			.set({ status: "running" })
			.where(
				and(
					eq(deployments.serviceId, serviceId),
					eq(deployments.status, "draining"),
				),
			);
	}

	await db
		.update(deployments)
		.set({ status: "rolled_back", failedStage: reason })
		.where(
			and(
				eq(deployments.rolloutId, rolloutId),
				inArray(deployments.status, [
					"pending",
					"pulling",
					"starting",
					"healthy",
					"failed",
				]),
			),
		);

	await db
		.update(rollouts)
		.set({ status: "rolled_back", completedAt: new Date() })
		.where(eq(rollouts.id, rolloutId));

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
