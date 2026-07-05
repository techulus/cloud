import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { deployments, rollouts, services } from "@/db/schema";
import { markDeploymentUndesired } from "@/lib/deployment-status";
import { sendDeploymentFailureAlert } from "@/lib/email";
import { isDeployedServerlessService } from "@/lib/service-config";

const ROLLOUT_FAILURE_CLEANUP_STATUSES = [
	"pending",
	"pulling",
	"starting",
	"healthy",
	"running",
	"sleeping",
	"waking",
	"failed",
] as const;

export function shouldRollBackDeploymentStatus(status: string) {
	return ROLLOUT_FAILURE_CLEANUP_STATUSES.includes(
		status as (typeof ROLLOUT_FAILURE_CLEANUP_STATUSES)[number],
	);
}

export function shouldRestoreDrainingDeploymentAsSleeping(
	deployment: { containerId: string | null },
	service: Parameters<typeof isDeployedServerlessService>[0] | null | undefined,
) {
	return (
		!deployment.containerId && !!service && isDeployedServerlessService(service)
	);
}

export async function restoreDrainingDeploymentsForRollback(serviceId: string) {
	const service = await db
		.select()
		.from(services)
		.where(eq(services.id, serviceId))
		.then((rows) => rows[0]);

	if (
		shouldRestoreDrainingDeploymentAsSleeping({ containerId: null }, service)
	) {
		await db
			.update(deployments)
			.set({ status: "sleeping", healthStatus: null })
			.where(
				and(
					eq(deployments.serviceId, serviceId),
					eq(deployments.status, "draining"),
					isNull(deployments.containerId),
				),
			);
	}

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
		.set({ ...markDeploymentUndesired("rolled_back"), failedStage: reason })
		.where(
			and(
				eq(deployments.rolloutId, rolloutId),
				inArray(deployments.status, ROLLOUT_FAILURE_CLEANUP_STATUSES),
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
