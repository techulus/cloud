import type { deployments } from "@/db/schema";

export const AUTOHEAL_UNHEALTHY_REPORTS = 3;
export const AUTOHEAL_MAX_RESTARTS = 3;
export const AUTOHEAL_MAX_RECREATES = 3;

type Deployment = typeof deployments.$inferSelect;

export function getStartingHealthCheckFailureUpdate({
	isRolloutDeployment,
	recreateCount,
}: {
	isRolloutDeployment: boolean;
	recreateCount: number;
}) {
	const recreateLimitReached =
		!isRolloutDeployment && recreateCount >= AUTOHEAL_MAX_RECREATES;
	const failedStage = isRolloutDeployment
		? "health_check"
		: recreateLimitReached
			? "autoheal_recreate_limit"
			: "autoheal_recreate";

	return {
		update: {
			observedPhase: "failed" as const,
			runtimeDesiredState:
				!isRolloutDeployment && !recreateLimitReached
					? ("running" as const)
					: ("removed" as const),
			trafficState:
				!isRolloutDeployment && !recreateLimitReached
					? ("active" as const)
					: ("inactive" as const),
			failedStage,
			...(isRolloutDeployment
				? {}
				: {
						unhealthyReportCount: 0,
						autohealRestartCount: 0,
						autohealRecreateCount: recreateLimitReached
							? recreateCount
							: recreateCount + 1,
					}),
		},
		recreateLimitReached,
		failedStage,
	};
}

export function getSteadyStateRecreateDecision({
	deployment,
	containerId,
}: {
	deployment: Deployment;
	containerId: string;
}) {
	const recreateCount = deployment.autohealRecreateCount ?? 0;

	if (recreateCount >= AUTOHEAL_MAX_RECREATES) {
		return {
			limitReached: true,
			updateFields: {
				observedPhase: "failed" as const,
				runtimeDesiredState: "removed" as const,
				trafficState: "inactive" as const,
				failedStage: "autoheal_recreate_limit",
				unhealthyReportCount: 0,
				autohealRestartCount: 0,
			},
			cleanupPayload: null,
		};
	}

	return {
		limitReached: false,
		updateFields: {
			observedPhase: "failed" as const,
			runtimeDesiredState: "running" as const,
			trafficState: "active" as const,
			failedStage: "autoheal_recreate",
			unhealthyReportCount: 0,
			autohealRestartCount: 0,
			autohealRecreateCount: recreateCount + 1,
		},
		cleanupPayload: {
			reason: "autoheal_recreate",
			deploymentId: deployment.id,
			serviceId: deployment.serviceId,
			containerIds: [containerId],
		},
	};
}
