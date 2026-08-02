import {
	escapePromQL,
	getQueryEndpoint,
	isMetricsEnabled,
	queryRangePromQL,
} from "@/lib/victoria-metrics";

const TARGET_UTILIZATION = 60;
const WINDOW_SECONDS = 180;
const STABILIZATION_MINUTES = 5;

export type AutoscalingHoldReason =
	| "metrics-disabled"
	| "no-active-deployments"
	| "provider-error"
	| "unexpected-series"
	| "invalid-sample"
	| "incomplete-coverage"
	| "stale-sample";

export type AutoscalingEvaluationPoint = {
	timestamp: string;
	cpuUtilizationPercent: number;
	memoryUtilizationPercent: number;
	coverage: Array<{
		deploymentId: string;
		cpuSourceTimestamp: string;
		memorySourceTimestamp: string;
	}>;
};

export type AutoscalingMetricResult =
	| { status: "ready"; points: AutoscalingEvaluationPoint[] }
	| { status: "hold"; reason: AutoscalingHoldReason };

export type AutoscalingRecommendation =
	| {
			status: "scale";
			direction: "up" | "down";
			targetReplicas: number;
			reason: "above-maximum" | "below-minimum" | "utilization";
	  }
	| {
			status: "hold";
			reason: AutoscalingHoldReason | "stable" | "downscale-stabilizing";
	  };

type MatrixResult = Awaited<ReturnType<typeof queryRangePromQL>>[number];

/**
 * Reads six one-minute evaluation points (now and the previous five minutes).
 * CPU is normalized against configured cores. The runtime rounds `--cpus` to
 * two decimals, so this introduces a small normalization error for finer limits.
 */
export async function queryAutoscalingMetrics(options: {
	serviceId: string;
	deploymentIds: string[];
	cpuLimitCores: number;
	memoryLimitMb: number;
	now?: Date;
}): Promise<AutoscalingMetricResult> {
	if (!isMetricsEnabled())
		return { status: "hold", reason: "metrics-disabled" };
	const deploymentIds = [...new Set(options.deploymentIds)].sort();
	if (deploymentIds.length === 0)
		return { status: "hold", reason: "no-active-deployments" };
	if (!(options.cpuLimitCores > 0) || !(options.memoryLimitMb > 0))
		return { status: "hold", reason: "invalid-sample" };

	const endpoint = getQueryEndpoint();
	if (!endpoint) return { status: "hold", reason: "metrics-disabled" };
	const end = new Date(
		Math.floor((options.now ?? new Date()).getTime() / 60_000) * 60_000,
	);
	const start = new Date(end.getTime() - STABILIZATION_MINUTES * 60_000);
	const ids = deploymentIds.map(escapeRegex).join("|");
	const selector = `service_id="${escapePromQL(options.serviceId)}",deployment_id=~"^(?:${ids})$"`;
	const metricQueries = [
		`avg_over_time(techulus_deployment_cpu_usage_cores{${selector}}[3m])`,
		`tlast_over_time(techulus_deployment_cpu_usage_cores{${selector}}[3m])`,
		`avg_over_time(techulus_deployment_memory_used_bytes{${selector}}[3m])`,
		`tlast_over_time(techulus_deployment_memory_used_bytes{${selector}}[3m])`,
	];

	let results: MatrixResult[][];
	try {
		results = await Promise.all(
			metricQueries.map((query) =>
				queryRangePromQL(endpoint, { query, start, end, stepSeconds: 60 }),
			),
		);
	} catch {
		return { status: "hold", reason: "provider-error" };
	}

	const allowed = new Set(deploymentIds);
	if (
		results.some((set) =>
			set.some((series) => !allowed.has(series.metric.deployment_id ?? "")),
		)
	)
		return { status: "hold", reason: "unexpected-series" };
	const maps = results.map(toSeriesMap);
	const points: AutoscalingEvaluationPoint[] = [];
	for (let time = start.getTime(); time <= end.getTime(); time += 60_000) {
		let cpuTotal = 0;
		let memoryTotal = 0;
		const coverage: AutoscalingEvaluationPoint["coverage"] = [];
		for (const deploymentId of deploymentIds) {
			const values = maps.map((map) => map.get(deploymentId)?.get(time / 1000));
			if (values.some((value) => value === undefined))
				return { status: "hold", reason: "incomplete-coverage" };
			const [cpu, cpuTimestamp, memory, memoryTimestamp] = values as number[];
			if (
				![cpu, cpuTimestamp, memory, memoryTimestamp].every(Number.isFinite) ||
				cpu < 0 ||
				memory < 0
			)
				return { status: "hold", reason: "invalid-sample" };
			if (
				time / 1000 - cpuTimestamp > WINDOW_SECONDS ||
				time / 1000 - memoryTimestamp > WINDOW_SECONDS
			)
				return { status: "hold", reason: "stale-sample" };
			cpuTotal += (cpu / options.cpuLimitCores) * 100;
			memoryTotal += (memory / (options.memoryLimitMb * 1024 * 1024)) * 100;
			coverage.push({
				deploymentId,
				cpuSourceTimestamp: new Date(cpuTimestamp * 1000).toISOString(),
				memorySourceTimestamp: new Date(memoryTimestamp * 1000).toISOString(),
			});
		}
		points.push({
			timestamp: new Date(time).toISOString(),
			cpuUtilizationPercent: cpuTotal / deploymentIds.length,
			memoryUtilizationPercent: memoryTotal / deploymentIds.length,
			coverage,
		});
	}
	return { status: "ready", points };
}

export function calculateAutoscalingRecommendation(options: {
	currentReplicas: number;
	minReplicas: number;
	maxReplicas: number;
	metrics: AutoscalingMetricResult;
}): AutoscalingRecommendation {
	const { currentReplicas, minReplicas, maxReplicas } = options;
	if (currentReplicas < minReplicas)
		return {
			status: "scale",
			direction: "up",
			targetReplicas: currentReplicas + 1,
			reason: "below-minimum",
		};
	if (currentReplicas > maxReplicas)
		return {
			status: "scale",
			direction: "down",
			targetReplicas: currentReplicas - 1,
			reason: "above-maximum",
		};
	if (options.metrics.status === "hold") return options.metrics;
	const recommendations = options.metrics.points.map((point) => ({
		cpu: resourceRecommendation(currentReplicas, point.cpuUtilizationPercent),
		memory: resourceRecommendation(
			currentReplicas,
			point.memoryUtilizationPercent,
		),
	}));
	const latest = recommendations.at(-1);
	if (!latest) return { status: "hold", reason: "incomplete-coverage" };
	const desiredUp = Math.max(latest.cpu, latest.memory);
	if (desiredUp > currentReplicas && currentReplicas < maxReplicas)
		return {
			status: "scale",
			direction: "up",
			targetReplicas: Math.min(maxReplicas, currentReplicas + 1),
			reason: "utilization",
		};
	if (latest.cpu >= currentReplicas || latest.memory >= currentReplicas)
		return { status: "hold", reason: "stable" };
	if (
		recommendations.length < STABILIZATION_MINUTES + 1 ||
		recommendations.some(
			(value) => Math.max(value.cpu, value.memory) >= currentReplicas,
		)
	)
		return { status: "hold", reason: "downscale-stabilizing" };
	const targetReplicas = Math.max(minReplicas, currentReplicas - 1);
	if (targetReplicas === currentReplicas)
		return { status: "hold", reason: "stable" };
	return {
		status: "scale",
		direction: "down",
		targetReplicas,
		reason: "utilization",
	};
}

function resourceRecommendation(current: number, utilization: number): number {
	if (utilization >= 54 && utilization <= 66) return current;
	return Math.ceil((current * utilization) / TARGET_UTILIZATION);
}

function toSeriesMap(
	results: MatrixResult[],
): Map<string, Map<number, number>> {
	const output = new Map<string, Map<number, number>>();
	for (const result of results) {
		const deploymentId = result.metric.deployment_id;
		if (!deploymentId) continue;
		if (output.has(deploymentId)) {
			output.delete(deploymentId);
			continue;
		}
		output.set(
			deploymentId,
			new Map(
				result.values.map(([timestamp, value]) => [timestamp, Number(value)]),
			),
		);
	}
	return output;
}

function escapeRegex(value: string): string {
	return escapePromQL(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}
