import type { ServiceWithDetails } from "@/db/types";
import { isObservedReady, isRuntimeExpected } from "@/lib/deployment-status";

type ServiceDeploymentActionInput = Pick<
	ServiceWithDetails,
	"configuredReplicas" | "deployments"
>;

export function getServiceDeploymentActionState(
	service: ServiceDeploymentActionInput,
) {
	const hasDeployments = service.deployments.length > 0;
	const hasExpectedDeployments = service.deployments.some((deployment) =>
		isRuntimeExpected(deployment.runtimeDesiredState),
	);
	const hasRestartableDeployments = service.deployments.some(
		(deployment) =>
			deployment.runtimeDesiredState === "running" &&
			isObservedReady(deployment.observedPhase) &&
			!!deployment.containerId,
	);
	const hasStoppedOrFailedDeployments =
		!hasExpectedDeployments &&
		service.deployments.some(
			(deployment) =>
				deployment.runtimeDesiredState === "removed" ||
				deployment.observedPhase === "failed",
		);
	const canStartAll =
		hasStoppedOrFailedDeployments && service.configuredReplicas.length > 0;

	return {
		hasDeployments,
		hasExpectedDeployments,
		hasRestartableDeployments,
		canStartAll,
	};
}
