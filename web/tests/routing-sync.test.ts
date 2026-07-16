import { describe, expect, it } from "vitest";
import {
	buildRoutingTargets,
	isRoutingSyncAcknowledgementEligible,
	selectRoutingSyncRolloutIds,
} from "@/lib/routing-sync";

describe("routing sync targets", () => {
	it("uses only workload servers for private services", () => {
		expect(
			buildRoutingTargets({
				workloadServerIds: ["worker-1", "worker-2"],
				proxyServerIds: ["proxy-1"],
				isPublic: false,
			}),
		).toEqual(["worker-1", "worker-2"]);
	});

	it("adds online proxies once for public services", () => {
		expect(
			buildRoutingTargets({
				workloadServerIds: ["worker-1", "proxy-1"],
				proxyServerIds: ["proxy-1", "proxy-2"],
				isPublic: true,
			}),
		).toEqual(["worker-1", "proxy-1", "proxy-2"]);
	});
});

describe("routing sync acknowledgements", () => {
	const activeRollout = {
		status: "in_progress",
		currentStage: "dns_sync",
		routingTargets: ["worker-1", "proxy-1"],
	};

	it("accepts only a persisted target for an active routing stage", () => {
		expect(isRoutingSyncAcknowledgementEligible(activeRollout, "proxy-1")).toBe(
			true,
		);
		expect(isRoutingSyncAcknowledgementEligible(activeRollout, "proxy-2")).toBe(
			false,
		);
	});

	it("rejects tokens for the wrong stage or terminal rollout", () => {
		expect(
			isRoutingSyncAcknowledgementEligible(
				{ ...activeRollout, currentStage: "health_check" },
				"worker-1",
			),
		).toBe(false);
		expect(
			isRoutingSyncAcknowledgementEligible(
				{ ...activeRollout, status: "completed" },
				"worker-1",
			),
		).toBe(false);
	});
});

describe("routing sync snapshot tokens", () => {
	const promotedRollout = {
		id: "rollout-1",
		serviceId: "service-1",
		serviceRevisionId: "revision-2",
		routingTargets: ["worker-1", "proxy-1"],
	};

	it("withholds a token until the routing snapshot uses its promoted revision", () => {
		expect(
			selectRoutingSyncRolloutIds({
				rollouts: [promotedRollout],
				runtimeServices: [{ id: "service-1", revisionId: "revision-1" }],
				serverId: "proxy-1",
			}),
		).toEqual([]);

		expect(
			selectRoutingSyncRolloutIds({
				rollouts: [promotedRollout],
				runtimeServices: [{ id: "service-1", revisionId: "revision-2" }],
				serverId: "proxy-1",
			}),
		).toEqual(["rollout-1"]);
	});

	it("withholds a revision-matched token from non-target servers", () => {
		expect(
			selectRoutingSyncRolloutIds({
				rollouts: [promotedRollout],
				runtimeServices: [{ id: "service-1", revisionId: "revision-2" }],
				serverId: "proxy-2",
			}),
		).toEqual([]);
	});
});
