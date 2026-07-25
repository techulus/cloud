import { describe, expect, it } from "vitest";
import {
	automaticPlacementIneligibilityReason,
	distributeReplicas,
} from "@/lib/inngest/functions/rollout-helpers";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";
import { getServiceRevisionTotalReplicas } from "@/lib/service-revision-spec";

describe("automatic placement distribution", () => {
	it("uses placement intent to determine a revision replica total", () => {
		expect(
			getServiceRevisionTotalReplicas({
				placement: { mode: "automatic", replicas: 4 },
				placements: [],
			}),
		).toBe(4);
		expect(
			getServiceRevisionTotalReplicas({
				placement: { mode: "manual" },
				placements: [
					{ serverId: "a", count: 1 },
					{ serverId: "b", count: 2 },
				],
			}),
		).toBe(3);
	});

	it.each([
		[1, [1, 0, 0]],
		[3, [1, 1, 1]],
		[5, [2, 2, 1]],
	])("distributes %i replicas over three servers", (replicas, counts) => {
		const result = distributeReplicas(["c", "a", "b"], replicas);
		expect(result.map((placement) => placement.serverId)).toEqual(
			["a", "b", "c"].slice(0, result.length),
		);
		expect(
			["a", "b", "c"].map(
				(id) => result.find((p) => p.serverId === id)?.replicas ?? 0,
			),
		).toEqual(counts);
	});

	it("stacks ten replicas deterministically on two servers", () => {
		expect(distributeReplicas(["b", "a"], 10)).toEqual([
			{ serverId: "a", replicas: 5 },
			{ serverId: "b", replicas: 5 },
		]);
	});
});

describe("automatic placement eligibility diagnostics", () => {
	const eligible = {
		status: "online",
		wireguardIp: "10.0.0.2",
		isProxy: false,
	};

	it.each([
		[{ ...eligible, status: "offline" }, "status is offline"],
		[{ ...eligible, wireguardIp: null }, "WireGuard is not configured"],
	])("reports why a server is ineligible", (server, reason) => {
		expect(automaticPlacementIneligibilityReason(server)).toBe(reason);
	});

	it("reports proxy eligibility only when required", () => {
		expect(automaticPlacementIneligibilityReason(eligible)).toBeNull();
		expect(automaticPlacementIneligibilityReason(eligible, true)).toBe(
			"not a proxy node",
		);
	});
});

describe("persisted revision compatibility", () => {
	it("normalizes v2 revisions to v3 manual intent", () => {
		const parsed = parseServiceRevisionSpec({
			schemaVersion: 2,
			image: "nginx",
			source: { type: "image", image: "nginx" },
			hostname: "web",
			stateful: false,
			serverless: {
				enabled: false,
				sleepAfterSeconds: 300,
				wakeTimeoutSeconds: 300,
			},
			healthCheck: null,
			startCommand: null,
			resourceLimits: { cpuCores: null, memoryMb: null },
			placements: [{ serverId: "a", count: 1 }],
			ports: [],
			secrets: [],
			volumes: [],
		});
		expect(parsed.schemaVersion).toBe(3);
		expect(parsed.placement).toEqual({ mode: "manual" });
	});
});
