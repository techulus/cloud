import { afterEach, describe, expect, it, vi } from "vitest";
import { queryNodeResourceUsageAverages } from "@/lib/victoria-metrics";

describe("VictoriaMetrics node resource averages", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("queries five-minute averages with enough samples for every server", async () => {
		vi.stubEnv("VICTORIA_METRICS_URL", "http://victoria.test");
		vi.stubEnv("VICTORIA_METRICS_PRIVATE_URL", "");

		const queries: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const query = new URL(String(input)).searchParams.get("query") ?? "";
				queries.push(query);
				if (query.includes("node_cpu")) {
					return response([
						{ metric: { server_id: "server-1" }, value: [1, "91"] },
						{ metric: { server_id: "server-2" }, value: [1, "42"] },
					]);
				}
				if (query.includes("node_memory")) {
					return response([
						{ metric: { server_id: "server-1" }, value: [1, "92"] },
					]);
				}
				return response([
					{ metric: { server_id: "server-2" }, value: [1, "86"] },
				]);
			}),
		);

		const averages = await queryNodeResourceUsageAverages([
			"server-1",
			"server-2",
		]);

		expect(queries).toHaveLength(3);
		expect(queries).toEqual(
			expect.arrayContaining([
				"avg_over_time(techulus_node_cpu_usage_percent[5m]) and (count_over_time(techulus_node_cpu_usage_percent[5m]) >= 3)",
				"avg_over_time(techulus_node_memory_usage_percent[5m]) and (count_over_time(techulus_node_memory_usage_percent[5m]) >= 3)",
				"avg_over_time(techulus_node_disk_usage_percent[5m]) and (count_over_time(techulus_node_disk_usage_percent[5m]) >= 3)",
			]),
		);
		expect(averages.get("server-1")).toEqual({
			cpuUsagePercent: 91,
			memoryUsagePercent: 92,
			diskUsagePercent: null,
		});
		expect(averages.get("server-2")).toEqual({
			cpuUsagePercent: 42,
			memoryUsagePercent: null,
			diskUsagePercent: 86,
		});
	});
});

function response(result: unknown[]) {
	return new Response(
		JSON.stringify({
			status: "success",
			data: { result },
		}),
	);
}
