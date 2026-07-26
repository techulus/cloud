import {
	isObservedReady,
	isObservedStarting,
	type ObservedPhase,
} from "@/lib/deployment-status";

export function summarizePlannedDeploymentHealth(
	plannedDeploymentIds: readonly string[],
	healthStates: ReadonlyArray<{ id: string; observedPhase: ObservedPhase }>,
) {
	const reportedIds = new Set(healthStates.map((deployment) => deployment.id));
	const missingDeploymentIds = plannedDeploymentIds.filter(
		(deploymentId) => !reportedIds.has(deploymentId),
	);
	const unresolvedDeploymentIds = healthStates
		.filter((deployment) => !isObservedReady(deployment.observedPhase))
		.map((deployment) => deployment.id);
	const hasTerminalFailure =
		missingDeploymentIds.length > 0 ||
		healthStates.some(
			(deployment) =>
				!isObservedReady(deployment.observedPhase) &&
				!isObservedStarting(deployment.observedPhase),
		);

	return {
		hasTerminalFailure,
		missingDeploymentIds,
		unresolvedDeploymentIds,
	};
}
