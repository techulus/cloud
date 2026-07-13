import { describe, expect, it } from "vitest";
import {
	isDeploymentRoutable,
	isObservedReady,
	isRuntimeExpected,
	markDeploymentRemoved,
	selectNewestRevisionId,
} from "@/lib/deployment-status";

describe("deployment state helpers", () => {
	it("keeps runtime intent separate from observed phase", () => {
		expect(isRuntimeExpected("running")).toBe(true);
		expect(isRuntimeExpected("stopped")).toBe(true);
		expect(isRuntimeExpected("removed")).toBe(false);

		expect(isObservedReady("healthy")).toBe(true);
		expect(isObservedReady("running")).toBe(true);
		expect(isObservedReady("sleeping")).toBe(false);
		expect(isObservedReady("waking")).toBe(false);
	});

	it("requires active traffic intent and a ready observation for routing", () => {
		expect(
			isDeploymentRoutable({
				trafficState: "active",
				observedPhase: "healthy",
			}),
		).toBe(true);
		expect(
			isDeploymentRoutable({
				trafficState: "candidate",
				observedPhase: "healthy",
			}),
		).toBe(false);
		expect(
			isDeploymentRoutable({
				trafficState: "active",
				observedPhase: "sleeping",
			}),
		).toBe(false);
	});

	it("represents removal as explicit runtime and traffic intent", () => {
		expect(markDeploymentRemoved()).toEqual({
			runtimeDesiredState: "removed",
			trafficState: "inactive",
		});
	});
});

describe("selectNewestRevisionId", () => {
	it("selects the highest revision deterministically", () => {
		expect(
			selectNewestRevisionId([
				{ serviceRevisionId: "revision-1", revisionNumber: 1 },
				{ serviceRevisionId: "revision-3", revisionNumber: 3 },
				{ serviceRevisionId: "revision-2", revisionNumber: 2 },
				{ serviceRevisionId: "revision-3", revisionNumber: 3 },
			]),
		).toBe("revision-3");
	});

	it("returns null when there are no active revisions", () => {
		expect(selectNewestRevisionId([])).toBeNull();
	});
});
