import { markDeploymentUndesired } from "@/lib/deployment-status";

export const SERVERLESS_WAKE_FAILURE_LIMIT = 3;

export function getServerlessWakeFailureUpdate({
	serverlessEnabled,
	currentFailureCount,
	failedStage,
}: {
	serverlessEnabled: boolean;
	currentFailureCount: number | null | undefined;
	failedStage: string;
}) {
	const nextFailureCount = (currentFailureCount ?? 0) + 1;
	const baseUpdate = {
		containerId: null,
		healthStatus: null,
		serverlessWakeFailureCount: nextFailureCount,
	};

	if (serverlessEnabled && nextFailureCount < SERVERLESS_WAKE_FAILURE_LIMIT) {
		return {
			...baseUpdate,
			status: "sleeping" as const,
			desired: true,
			failedStage: null,
		};
	}

	return {
		...markDeploymentUndesired("failed"),
		...baseUpdate,
		failedStage,
	};
}
