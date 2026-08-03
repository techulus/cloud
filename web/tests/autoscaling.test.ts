import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AutoscalingMetricResult,
	calculateAutoscalingRecommendation,
	queryAutoscalingMetrics,
} from "@/lib/autoscaling";

const point = (cpu: number, memory: number) => ({
	timestamp: "2026-08-02T12:00:00.000Z",
	cpuUtilizationPercent: cpu,
	memoryUtilizationPercent: memory,
	coverage: [],
});
const ready = (
	cpu: number,
	memory: number,
	count = 6,
): AutoscalingMetricResult => ({
	status: "ready",
	points: Array.from({ length: count }, () => point(cpu, memory)),
});

describe("calculateAutoscalingRecommendation", () => {
	it("lets either resource drive scale-up and requires both for scale-down", () => {
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 4,
				minReplicas: 1,
				maxReplicas: 10,
				metrics: ready(30, 90),
			}),
		).toMatchObject({ status: "scale", direction: "up", targetReplicas: 6 });
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 4,
				minReplicas: 1,
				maxReplicas: 10,
				metrics: ready(30, 60),
			}),
		).toEqual({ status: "hold", reason: "stable" });
	});

	it.each([
		[53.9, "down"],
		[54, "hold"],
		[66, "hold"],
		[66.1, "up"],
	] as const)("applies the inclusive deadband at %s", (utilization, expected) => {
		const result = calculateAutoscalingRecommendation({
			currentReplicas: 20,
			minReplicas: 1,
			maxReplicas: 32,
			metrics: ready(utilization, utilization),
		});
		expect(result.status === "scale" ? result.direction : result.status).toBe(
			expected,
		);
	});

	it("clamps directly to policy bounds without metrics", () => {
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 1,
				minReplicas: 4,
				maxReplicas: 8,
			}),
		).toMatchObject({ targetReplicas: 4, reason: "below-minimum" });
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 10,
				minReplicas: 2,
				maxReplicas: 8,
			}),
		).toMatchObject({ targetReplicas: 8, reason: "above-maximum" });
	});

	it("reports when metrics were not queried within policy bounds", () => {
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 4,
				minReplicas: 2,
				maxReplicas: 8,
			}),
		).toEqual({ status: "hold", reason: "metrics-not-queried" });
	});

	it("clamps direct scale-up recommendations to the maximum", () => {
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 4,
				minReplicas: 1,
				maxReplicas: 8,
				metrics: ready(200, 30),
			}),
		).toMatchObject({ status: "scale", direction: "up", targetReplicas: 8 });
	});

	it("continues scaling down only one replica after stabilization", () => {
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 8,
				minReplicas: 1,
				maxReplicas: 10,
				metrics: ready(30, 30),
			}),
		).toMatchObject({ status: "scale", direction: "down", targetReplicas: 7 });
	});

	it("clamps utilization actions and propagates incomplete coverage", () => {
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 32,
				minReplicas: 1,
				maxReplicas: 32,
				metrics: ready(100, 100),
			}),
		).toEqual({ status: "hold", reason: "stable" });
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 1,
				minReplicas: 1,
				maxReplicas: 32,
				metrics: ready(1, 1),
			}),
		).toEqual({ status: "hold", reason: "stable" });
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 4,
				minReplicas: 1,
				maxReplicas: 8,
				metrics: { status: "hold", reason: "incomplete-coverage" },
			}),
		).toEqual({ status: "hold", reason: "incomplete-coverage" });
	});

	it("holds low utilization at the minimum replica count", () => {
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 2,
				minReplicas: 2,
				maxReplicas: 8,
				metrics: ready(20, 20),
			}),
		).toEqual({ status: "hold", reason: "stable" });
	});

	it("requires all six points to remain below current for downscale", () => {
		const metrics = ready(30, 30);
		if (metrics.status === "ready") metrics.points[0] = point(90, 30);
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 4,
				minReplicas: 1,
				maxReplicas: 8,
				metrics,
			}),
		).toEqual({ status: "hold", reason: "downscale-stabilizing" });
		expect(
			calculateAutoscalingRecommendation({
				currentReplicas: 4,
				minReplicas: 1,
				maxReplicas: 8,
				metrics: ready(30, 30, 5),
			}),
		).toEqual({ status: "hold", reason: "downscale-stabilizing" });
	});
});

describe("queryAutoscalingMetrics", () => {
	afterEach(() => {
		delete process.env.VICTORIA_METRICS_URL;
		vi.unstubAllGlobals();
	});

	it("checks metrics configuration explicitly", async () => {
		await expect(
			queryAutoscalingMetrics({
				serviceId: "svc",
				deploymentIds: ["dep"],
				cpuLimitCores: 1,
				memoryLimitMb: 100,
			}),
		).resolves.toEqual({ status: "hold", reason: "metrics-disabled" });
	});

	it("returns six normalized points with exact per-deployment coverage", async () => {
		process.env.VICTORIA_METRICS_URL = "http://metrics.test";
		const times = Array.from(
			{ length: 6 },
			(_, index) => 1_754_136_900 + index * 60,
		);
		let call = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const query = new URL(String(input)).searchParams.get("query") ?? "";
				expect(query).toContain('service_id="svc"');
				expect(query).toContain('deployment_id=~"^(?:dep-a|dep-b)$"');
				const timestampQuery = query.startsWith("tlast_over_time");
				const memoryQuery = query.includes("memory_used_bytes");
				call++;
				return new Response(
					JSON.stringify({
						status: "success",
						data: {
							result: ["dep-a", "dep-b"].map((deploymentId) => ({
								metric: { deployment_id: deploymentId },
								values: times.map((time) => [
									time,
									String(
										timestampQuery
											? time
											: memoryQuery
												? 50 * 1024 * 1024
												: 0.5,
									),
								]),
							})),
						},
					}),
					{ status: 200 },
				);
			}),
		);
		const result = await queryAutoscalingMetrics({
			serviceId: "svc",
			deploymentIds: ["dep-b", "dep-a"],
			cpuLimitCores: 1,
			memoryLimitMb: 100,
			now: new Date(times[5] * 1000),
		});
		expect(call).toBe(4);
		expect(result.status).toBe("ready");
		if (result.status === "ready") {
			expect(result.points).toHaveLength(6);
			expect(result.points[0]).toMatchObject({
				cpuUtilizationPercent: 50,
				memoryUtilizationPercent: 50,
				coverage: [{ deploymentId: "dep-a" }, { deploymentId: "dep-b" }],
			});
		}
	});

	it.each([
		["missing series", "incomplete-coverage", []],
		["unexpected series", "unexpected-series", ["other"]],
	] as const)("holds for %s", async (_name, reason, ids) => {
		process.env.VICTORIA_METRICS_URL = "http://metrics.test";
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "success",
							data: {
								result: ids.map((deployment_id) => ({
									metric: { deployment_id },
									values: [],
								})),
							},
						}),
					),
			),
		);
		await expect(
			queryAutoscalingMetrics({
				serviceId: "svc",
				deploymentIds: ["dep"],
				cpuLimitCores: 1,
				memoryLimitMb: 100,
				now: new Date("2026-08-02T12:00:00Z"),
			}),
		).resolves.toEqual({ status: "hold", reason });
	});

	it("holds coverage after any number of duplicate deployment series", async () => {
		process.env.VICTORIA_METRICS_URL = "http://metrics.test";
		const end = Date.parse("2026-08-02T12:00:00Z") / 1000;
		const times = Array.from(
			{ length: 6 },
			(_, index) => end - 300 + index * 60,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const query = new URL(String(input)).searchParams.get("query") ?? "";
				const timestampQuery = query.startsWith("tlast_over_time");
				return new Response(
					JSON.stringify({
						status: "success",
						data: {
							result: Array.from({ length: 3 }, () => ({
								metric: { deployment_id: "dep" },
								values: times.map((time) => [
									time,
									String(timestampQuery ? time : 1),
								]),
							})),
						},
					}),
				);
			}),
		);
		await expect(
			queryAutoscalingMetrics({
				serviceId: "svc",
				deploymentIds: ["dep"],
				cpuLimitCores: 1,
				memoryLimitMb: 100,
				now: new Date("2026-08-02T12:00:00Z"),
			}),
		).resolves.toEqual({ status: "hold", reason: "incomplete-coverage" });
	});
});
