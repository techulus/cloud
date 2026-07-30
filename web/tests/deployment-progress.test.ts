import { describe, expect, it } from "vitest";
import { getBarState } from "@/components/service/details/deployment-progress";
import type { ServiceWithDetails } from "@/db/types";
import type { ConfigChange } from "@/lib/service-config";

const pendingChanges: ConfigChange[] = [
	{ field: "Image", from: "old", to: "new" },
];

function service(
	overrides: Partial<ServiceWithDetails> = {},
): ServiceWithDetails {
	return {
		migrationStatus: null,
		latestBuild: null,
		activeBuild: null,
		rollouts: [],
		activeRollout: null,
		deployments: [],
		configuredReplicas: [{ count: 1 }],
		replicas: 1,
		placementMode: "manual",
		...overrides,
	} as ServiceWithDetails;
}

const completedRollout = {
	id: "rollout-completed",
	status: "completed" as const,
};

const activeRollout = {
	id: "rollout-active",
	status: "in_progress" as const,
	currentStage: "health_check",
};

describe("deployment progress state", () => {
	it("uses an active sibling build when the latest platform build completed", () => {
		expect(
			getBarState(
				service({
					latestBuild: { id: "build-completed", status: "completed" },
					activeBuild: { id: "build-active", status: "building" },
				}),
				pendingChanges,
			),
		).toEqual({
			mode: "building",
			buildId: "build-active",
			buildStatus: "building",
		});
	});

	it("uses an active rollout when the latest rollout is terminal", () => {
		expect(
			getBarState(
				service({
					rollouts: [completedRollout] as ServiceWithDetails["rollouts"],
					activeRollout: activeRollout as ServiceWithDetails["activeRollout"],
				}),
				pendingChanges,
			),
		).toMatchObject({
			mode: "deploying",
			rolloutId: "rollout-active",
			stage: "health_check",
		});
	});

	it("shows pending changes only when active build and rollout are absent", () => {
		expect(getBarState(service(), pendingChanges)).toEqual({
			mode: "ready",
			hasChanges: true,
			changesCount: 1,
		});
	});

	it("preserves active latest-record fallbacks for legacy payloads", () => {
		expect(
			getBarState(
				service({
					activeBuild: undefined,
					latestBuild: { id: "legacy-build", status: "pushing" },
				}),
				pendingChanges,
			),
		).toMatchObject({ mode: "building", buildId: "legacy-build" });

		expect(
			getBarState(
				service({
					activeRollout: undefined,
					rollouts: [activeRollout] as ServiceWithDetails["rollouts"],
				}),
				pendingChanges,
			),
		).toMatchObject({ mode: "deploying", rolloutId: "rollout-active" });
	});

	it("keeps migration ahead of build and rollout activity", () => {
		expect(
			getBarState(
				service({
					migrationStatus: "stopping",
					activeBuild: { id: "build-active", status: "building" },
					activeRollout: activeRollout as ServiceWithDetails["activeRollout"],
				}),
				pendingChanges,
			),
		).toMatchObject({ mode: "deploying", stage: "migrating" });
	});

	it("keeps build activity ahead of rollout activity", () => {
		expect(
			getBarState(
				service({
					activeBuild: { id: "build-active", status: "building" },
					activeRollout: activeRollout as ServiceWithDetails["activeRollout"],
				}),
				pendingChanges,
			),
		).toMatchObject({ mode: "building", buildId: "build-active" });
	});
});
