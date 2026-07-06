import type { deployments } from "@/db/schema";

export type RuntimeDesiredState =
	typeof deployments.$inferSelect.runtimeDesiredState;
export type TrafficState = typeof deployments.$inferSelect.trafficState;
export type ObservedPhase = typeof deployments.$inferSelect.observedPhase;

export type DeploymentState = {
	runtimeDesiredState: RuntimeDesiredState;
	trafficState: TrafficState;
	observedPhase: ObservedPhase;
};

export const runtimeExpectedStates = ["running", "stopped"] as const satisfies
	readonly RuntimeDesiredState[];

export const activeTrafficStates = ["active"] as const satisfies
	readonly TrafficState[];

export const observedReadyPhases = ["healthy", "running"] as const satisfies
	readonly ObservedPhase[];

export const observedStartingPhases = [
	"pending",
	"pulling",
	"starting",
	"waking",
] as const satisfies readonly ObservedPhase[];

export const observedActiveContainerPhases = [
	"starting",
	"healthy",
	"running",
] as const satisfies readonly ObservedPhase[];

export function isRuntimeExpected(
	runtimeDesiredState: RuntimeDesiredState,
): boolean {
	return runtimeDesiredState !== "removed";
}

export function isObservedReady(observedPhase: ObservedPhase): boolean {
	return (observedReadyPhases as readonly ObservedPhase[]).includes(
		observedPhase,
	);
}

export function isObservedStarting(observedPhase: ObservedPhase): boolean {
	return (observedStartingPhases as readonly ObservedPhase[]).includes(
		observedPhase,
	);
}

export function isObservedActiveContainer(
	observedPhase: ObservedPhase,
): boolean {
	return (observedActiveContainerPhases as readonly ObservedPhase[]).includes(
		observedPhase,
	);
}

export function isTrafficActive(trafficState: TrafficState): boolean {
	return trafficState === "active";
}

export function isDeploymentExpected(
	deployment: Pick<DeploymentState, "runtimeDesiredState">,
): boolean {
	return isRuntimeExpected(deployment.runtimeDesiredState);
}

export function isDeploymentRoutable(
	deployment: Pick<DeploymentState, "trafficState" | "observedPhase">,
): boolean {
	return (
		isTrafficActive(deployment.trafficState) &&
		isObservedReady(deployment.observedPhase)
	);
}

export function markDeploymentRemoved() {
	return {
		runtimeDesiredState: "removed" as const,
		trafficState: "inactive" as const,
	};
}

export function markDeploymentFailedRemoved(failedStage: string) {
	return {
		...markDeploymentRemoved(),
		observedPhase: "failed" as const,
		healthStatus: null,
		failedStage,
	};
}
