import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { deployments, rollouts } from "@/db/schema";
import { markDeploymentFailedRemoved } from "@/lib/deployment-status";
import { sendDeploymentFailureAlert } from "@/lib/email";

export function shouldRollBackDeploymentState(deployment: {
	trafficState: string;
	runtimeDesiredState: string;
}) {
	void deployment.trafficState;
	return deployment.runtimeDesiredState !== "removed";
}

export function shouldRestoreDrainingDeployment(deployment: {
	trafficState: string;
	runtimeDesiredState: string;
}) {
	return (
		deployment.trafficState === "draining" &&
		deployment.runtimeDesiredState !== "removed"
	);
}

export async function restoreDrainingDeploymentsForRollback(serviceId: string) {
	await db
		.update(deployments)
		.set({ trafficState: "active" })
		.where(
			and(
				eq(deployments.serviceId, serviceId),
				eq(deployments.trafficState, "draining"),
			),
		);
}

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

	await db
		.update(rollouts)
		.set({
			status: rolloutDeployments.length === 0 ? "failed" : "rolled_back",
			currentStage: reason,
			completedAt: new Date(),
		})
		.where(eq(rollouts.id, rolloutId));

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

	if (isRollingUpdate) {
		await restoreDrainingDeploymentsForRollback(serviceId);
	}

	await db
		.update(deployments)
		.set(markDeploymentFailedRemoved(reason))
		.where(
			and(
				eq(deployments.rolloutId, rolloutId),
				ne(deployments.runtimeDesiredState, "removed"),
			),
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
