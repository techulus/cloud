import { afterEach, describe, expect, it, vi } from "vitest";
import {
	deriveBunnyRecordName,
	planBunnyReconciliation,
	reconcileBunny,
} from "@/lib/bunny-dns";
import { computeEdgeEligibility } from "@/lib/edge-dns";

describe("Edge DNS", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("selects only fresh ready IPv4 proxies and reports exclusions", () => {
		const now = new Date("2026-07-22T12:00:00Z");
		const base = {
			isProxy: true,
			status: "online",
			lastHeartbeat: now,
			networkHealth: { tunnelUp: true },
		};
		const result = computeEdgeEligibility(
			[
				{ ...base, id: "a", name: "ready", publicIp: "203.0.113.2" },
				{ ...base, id: "b", name: "ipv6", publicIp: "2001:db8::1" },
				{
					...base,
					id: "c",
					name: "stale",
					publicIp: "203.0.113.3",
					lastHeartbeat: new Date(now.getTime() - 76_000),
				},
			],
			now,
		);
		expect(result.targets).toEqual(["203.0.113.2"]);
		expect(result.excluded.map((item) => item.reasons)).toEqual([
			["No valid IPv4 address"],
			["Heartbeat is stale"],
		]);
	});

	it("derives and validates the relative Bunny record name", () => {
		expect(deriveBunnyRecordName("edge.techulus.app", "techulus.app")).toBe(
			"edge",
		);
		expect(() =>
			deriveBunnyRecordName("edge.example.com", "techulus.app"),
		).toThrow("not contained");
	});

	it("only reconciles claimed records and leaves provider policy untouched", () => {
		const records = [
			{ Id: 1, Type: 0, Name: "edge", Value: "1.1.1.1" },
			{ Id: 2, Type: 0, Name: "edge", Value: "2.2.2.2" },
			{ Id: 3, Type: 0, Name: "edge", Value: "4.4.4.4" },
			{ Id: 4, Type: 1, Name: "edge", Value: "ignored" },
			{
				Id: 5,
				Type: 0,
				Name: "edge",
				Value: "5.5.5.5",
				Comment: "Managed by Techulus Cloud",
			},
		];
		const plan = planBunnyReconciliation(
			records,
			"edge",
			["1.1.1.1", "3.3.3.3"],
			["1", "2"],
		);
		expect(plan.remove.map((r) => r.Id)).toEqual([2, 5]);
		expect(plan.add).toEqual(["3.3.3.3"]);
	});

	it("adds Bunny records before deleting stale claimed targets", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						Domain: "example.com",
						Records: [
							{ Id: 1, Type: 0, Name: "edge", Value: "1.1.1.1" },
							{ Id: 2, Type: 0, Name: "edge", Value: "2.2.2.2" },
						],
					}),
				),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ Id: 3 })))
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						Records: [
							{ Id: 1, Type: 0, Name: "edge", Value: "1.1.1.1" },
							{ Id: 3, Type: 0, Name: "edge", Value: "3.3.3.3" },
						],
					}),
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		await reconcileBunny(
			{
				enabled: true,
				provider: "bunny",
				zoneId: "42",
				encryptedAccessKey: "unused",
				claimedHostname: "edge.example.com",
			},
			"secret",
			"edge.example.com",
			["1.1.1.1", "3.3.3.3"],
			["1", "2"],
		);

		expect(
			fetchMock.mock.calls.slice(1, 3).map((call) => call[1]?.method),
		).toEqual(["PUT", "DELETE"]);
		const createBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
		expect(createBody).toEqual({
			Type: 0,
			Name: "edge",
			Value: "3.3.3.3",
			Comment: "Managed by Techulus Cloud",
		});
	});
});
