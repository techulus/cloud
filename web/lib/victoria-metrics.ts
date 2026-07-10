import {
	addMilliseconds,
	getTimestamp,
	SECOND_IN_MILLISECONDS,
	subtractMilliseconds,
} from "@/lib/date";
import {
	METRIC_RANGE_OPTIONS,
	type MetricRange,
	parseMetricRange,
} from "@/lib/metric-ranges";

export { METRIC_RANGE_OPTIONS, type MetricRange, parseMetricRange };

let hasWarnedMissingMetricsConfig = false;

type EndpointConfig = {
	url: string;
	username?: string;
	password?: string;
};

type VictoriaInstantResponse = {
	status: string;
	data?: {
		result?: Array<{
			metric?: Record<string, string>;
			value?: [number, string];
		}>;
	};
	error?: string;
};

type VictoriaMatrixResult = {
	metric: Record<string, string>;
	values: Array<[number, string]>;
};

type VictoriaMatrixResponse = {
	status: string;
	data?: {
		result?: VictoriaMatrixResult[];
	};
	error?: string;
};

export type NodeMetricsSnapshot = {
	cpuUsagePercent: number | null;
	memoryUsagePercent: number | null;
	memoryUsedBytes: number | null;
	diskUsagePercent: number | null;
	diskUsedBytes: number | null;
};

export type NodeMetricPoint = {
	timestamp: string;
	value: number;
};

export type ServiceMetricsBucket = {
	timestamp: string;
	totalRequests: number;
	statuses: Record<string, number>;
	p50ResponseTimeMs: number | null;
	p90ResponseTimeMs: number | null;
	p95ResponseTimeMs: number | null;
	p99ResponseTimeMs: number | null;
	ingressBytesPerSecond: number | null;
	egressBytesPerSecond: number | null;
	cpuUsagePercent: number | null;
	memoryUsagePercent: number | null;
	memoryUsedBytes: number | null;
};

export type ServiceMetrics = {
	metricsEnabled: boolean;
	range: MetricRange;
	windowStart: string;
	windowEnd: string;
	stepSeconds: number;
	totalRequests: number;
	statusCodes: string[];
	buckets: ServiceMetricsBucket[];
};

export type NodeMetricsHistory = {
	cpuUsagePercent: NodeMetricPoint[];
	memoryUsagePercent: NodeMetricPoint[];
	memoryUsedBytes: NodeMetricPoint[];
	diskUsagePercent: NodeMetricPoint[];
	diskUsedBytes: NodeMetricPoint[];
};

export type MetricsHistory = NodeMetricsHistory;

export type ServerMetricsHistory = {
	serverId: string;
	serverName: string;
	history: MetricsHistory;
};

const METRIC_NAMES = {
	cpuUsagePercent: "techulus_node_cpu_usage_percent",
	memoryUsagePercent: "techulus_node_memory_usage_percent",
	memoryUsedBytes: "techulus_node_memory_used_bytes",
	diskUsagePercent: "techulus_node_disk_usage_percent",
	diskUsedBytes: "techulus_node_disk_used_bytes",
} as const;

function parseEndpoint(endpoint: string): EndpointConfig {
	const parsed = new URL(endpoint);
	const username = parsed.username || undefined;
	const password = parsed.password || undefined;
	parsed.username = "";
	parsed.password = "";
	return { url: parsed.toString().replace(/\/$/, ""), username, password };
}

function getQueryEndpoint(): EndpointConfig | undefined {
	const endpoint =
		process.env.VICTORIA_METRICS_PRIVATE_URL ||
		process.env.VICTORIA_METRICS_URL;
	if (!endpoint) return undefined;
	return parseEndpoint(endpoint);
}

function buildFetchOptions(config: EndpointConfig): RequestInit {
	if (config.username) {
		const credentials = Buffer.from(
			`${config.username}:${config.password || ""}`,
		).toString("base64");
		return { headers: { Authorization: `Basic ${credentials}` } };
	}
	return {};
}

export function isMetricsEnabled(): boolean {
	return !!(
		process.env.VICTORIA_METRICS_PRIVATE_URL || process.env.VICTORIA_METRICS_URL
	);
}

export function warnMissingMetricsConfig(context: string) {
	if (hasWarnedMissingMetricsConfig) return;

	hasWarnedMissingMetricsConfig = true;
	console.warn(
		`[metrics:${context}] Missing VictoriaMetrics configuration: set VICTORIA_METRICS_URL or VICTORIA_METRICS_PRIVATE_URL to enable metrics history.`,
	);
}

export async function queryNodeMetricsSnapshots(
	serverIds: string[],
): Promise<Map<string, NodeMetricsSnapshot>> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) return new Map();

	// 5 total queries (one per metric), results grouped by server_id label.
	// This collapses the previous N × 5 fan-out.
	const [cpuMap, memPctMap, memBytesMap, diskPctMap, diskBytesMap] =
		await Promise.all([
			queryInstantMetricGroup(endpoint, METRIC_NAMES.cpuUsagePercent).catch(
				() => new Map<string, number | null>(),
			),
			queryInstantMetricGroup(endpoint, METRIC_NAMES.memoryUsagePercent).catch(
				() => new Map<string, number | null>(),
			),
			queryInstantMetricGroup(endpoint, METRIC_NAMES.memoryUsedBytes).catch(
				() => new Map<string, number | null>(),
			),
			queryInstantMetricGroup(endpoint, METRIC_NAMES.diskUsagePercent).catch(
				() => new Map<string, number | null>(),
			),
			queryInstantMetricGroup(endpoint, METRIC_NAMES.diskUsedBytes).catch(
				() => new Map<string, number | null>(),
			),
		]);

	const result = new Map<string, NodeMetricsSnapshot>();
	for (const serverId of serverIds) {
		result.set(serverId, {
			cpuUsagePercent: cpuMap.get(serverId) ?? null,
			memoryUsagePercent: memPctMap.get(serverId) ?? null,
			memoryUsedBytes: memBytesMap.get(serverId) ?? null,
			diskUsagePercent: diskPctMap.get(serverId) ?? null,
			diskUsedBytes: diskBytesMap.get(serverId) ?? null,
		});
	}
	return result;
}

export async function queryNodeMetricsSnapshot(
	serverId: string,
): Promise<NodeMetricsSnapshot | null> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) return null;

	const snapshot: NodeMetricsSnapshot = {
		cpuUsagePercent: null,
		memoryUsagePercent: null,
		memoryUsedBytes: null,
		diskUsagePercent: null,
		diskUsedBytes: null,
	};

	await Promise.all(
		Object.entries(METRIC_NAMES).map(async ([key, metricName]) => {
			const value = await queryInstantMetric(
				endpoint,
				metricName,
				serverId,
			).catch(() => null);
			snapshot[key as keyof NodeMetricsSnapshot] = value;
		}),
	);

	return snapshot;
}

export async function queryNodeMetricsHistory(options: {
	serverId: string;
	start: Date;
	end: Date;
	stepSeconds: number;
}): Promise<NodeMetricsHistory> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) return emptyHistory();

	const entries = await Promise.all(
		Object.entries(METRIC_NAMES).map(async ([key, metricName]) => {
			const series = await queryRangeMetric(endpoint, {
				metricName,
				serverId: options.serverId,
				start: options.start,
				end: options.end,
				stepSeconds: options.stepSeconds,
			}).catch(() => []);
			return [key, series] as const;
		}),
	);

	return Object.fromEntries(entries) as NodeMetricsHistory;
}

export async function queryServersMetricsHistory(options: {
	servers: Array<{ id: string; name: string }>;
	start: Date;
	end: Date;
	stepSeconds: number;
}): Promise<ServerMetricsHistory[]> {
	const endpoint = getQueryEndpoint();
	if (!endpoint || options.servers.length === 0) return [];

	const [cpuMap, memPctMap, memBytesMap, diskPctMap, diskBytesMap] =
		await Promise.all([
			queryRangeMetricGroup(endpoint, {
				metricName: METRIC_NAMES.cpuUsagePercent,
				start: options.start,
				end: options.end,
				stepSeconds: options.stepSeconds,
			}).catch(() => new Map<string, NodeMetricPoint[]>()),
			queryRangeMetricGroup(endpoint, {
				metricName: METRIC_NAMES.memoryUsagePercent,
				start: options.start,
				end: options.end,
				stepSeconds: options.stepSeconds,
			}).catch(() => new Map<string, NodeMetricPoint[]>()),
			queryRangeMetricGroup(endpoint, {
				metricName: METRIC_NAMES.memoryUsedBytes,
				start: options.start,
				end: options.end,
				stepSeconds: options.stepSeconds,
			}).catch(() => new Map<string, NodeMetricPoint[]>()),
			queryRangeMetricGroup(endpoint, {
				metricName: METRIC_NAMES.diskUsagePercent,
				start: options.start,
				end: options.end,
				stepSeconds: options.stepSeconds,
			}).catch(() => new Map<string, NodeMetricPoint[]>()),
			queryRangeMetricGroup(endpoint, {
				metricName: METRIC_NAMES.diskUsedBytes,
				start: options.start,
				end: options.end,
				stepSeconds: options.stepSeconds,
			}).catch(() => new Map<string, NodeMetricPoint[]>()),
		]);

	return options.servers.map((server) => ({
		serverId: server.id,
		serverName: server.name,
		history: {
			cpuUsagePercent: cpuMap.get(server.id) ?? [],
			memoryUsagePercent: memPctMap.get(server.id) ?? [],
			memoryUsedBytes: memBytesMap.get(server.id) ?? [],
			diskUsagePercent: diskPctMap.get(server.id) ?? [],
			diskUsedBytes: diskBytesMap.get(server.id) ?? [],
		},
	}));
}

export function createEmptyServiceMetrics(
	range: MetricRange,
	now = new Date(),
): ServiceMetrics {
	const window = getMetricWindow(range, now);
	return {
		metricsEnabled: false,
		range,
		windowStart: window.start.toISOString(),
		windowEnd: window.end.toISOString(),
		stepSeconds: window.stepSeconds,
		totalRequests: 0,
		statusCodes: [],
		buckets: [],
	};
}

export async function queryServiceMetrics(options: {
	serviceId: string;
	range: MetricRange;
	now?: Date;
}): Promise<ServiceMetrics> {
	const endpoint = getQueryEndpoint();
	const now = options.now ?? new Date();
	const window = getMetricWindow(options.range, now);
	if (!endpoint) return createEmptyServiceMetrics(options.range, now);

	const serviceMatcher = buildTraefikServiceMatcher(options.serviceId);
	const serviceId = escapePromQL(options.serviceId);
	const rangeWindow = formatPromDuration(window.stepSeconds);
	const traefikFilter = `service=~"${serviceMatcher}"`;
	const queryStart = addMilliseconds(
		window.start,
		window.stepSeconds * SECOND_IN_MILLISECONDS,
	);

	const [
		requestResults,
		p50Results,
		p90Results,
		p95Results,
		p99Results,
		ingressResults,
		egressResults,
		cpuResults,
		memoryPercentResults,
		memoryBytesResults,
	] = await Promise.all([
		queryRangePromQL(endpoint, {
			query: `sum by (code) (increase(traefik_service_requests_total{${traefikFilter}}[${rangeWindow}]))`,
			start: queryStart,
			end: window.end,
			stepSeconds: window.stepSeconds,
		}).catch(() => []),
		queryRangePromQL(endpoint, {
			query: responseTimeQuery(0.5, traefikFilter, rangeWindow),
			start: queryStart,
			end: window.end,
			stepSeconds: window.stepSeconds,
		}).catch(() => []),
		queryRangePromQL(endpoint, {
			query: responseTimeQuery(0.9, traefikFilter, rangeWindow),
			start: queryStart,
			end: window.end,
			stepSeconds: window.stepSeconds,
		}).catch(() => []),
		queryRangePromQL(endpoint, {
			query: responseTimeQuery(0.95, traefikFilter, rangeWindow),
			start: queryStart,
			end: window.end,
			stepSeconds: window.stepSeconds,
		}).catch(() => []),
		queryRangePromQL(endpoint, {
			query: responseTimeQuery(0.99, traefikFilter, rangeWindow),
			start: queryStart,
			end: window.end,
			stepSeconds: window.stepSeconds,
		}).catch(() => []),
		queryRangePromQL(endpoint, {
			query: `sum(rate(traefik_service_requests_bytes_total{${traefikFilter}}[${rangeWindow}]))`,
			start: queryStart,
			end: window.end,
			stepSeconds: window.stepSeconds,
		}).catch(() => []),
		queryRangePromQL(endpoint, {
			query: `sum(rate(traefik_service_responses_bytes_total{${traefikFilter}}[${rangeWindow}]))`,
			start: queryStart,
			end: window.end,
			stepSeconds: window.stepSeconds,
		}).catch(() => []),
		queryRangePromQL(endpoint, {
			query: `sum(avg_over_time(techulus_service_cpu_usage_percent{service_id="${serviceId}"}[${rangeWindow}]))`,
			start: queryStart,
			end: window.end,
			stepSeconds: window.stepSeconds,
		}).catch(() => []),
		queryRangePromQL(endpoint, {
			query: `sum(avg_over_time(techulus_service_memory_usage_percent{service_id="${serviceId}"}[${rangeWindow}]))`,
			start: queryStart,
			end: window.end,
			stepSeconds: window.stepSeconds,
		}).catch(() => []),
		queryRangePromQL(endpoint, {
			query: `sum(avg_over_time(techulus_service_memory_used_bytes{service_id="${serviceId}"}[${rangeWindow}]))`,
			start: queryStart,
			end: window.end,
			stepSeconds: window.stepSeconds,
		}).catch(() => []),
	]);

	const buckets = createServiceMetricBuckets(window);
	const bucketsByTimestamp = new Map(
		buckets.map((bucket) => [bucket.timestamp, bucket]),
	);
	const statusCodes = new Set<string>();

	for (const result of requestResults) {
		const status = normalizeHTTPStatusFamily(result.metric.code);
		statusCodes.add(status);
		for (const point of matrixResultToPoints(result)) {
			const bucket = bucketsByTimestamp.get(point.timestamp);
			if (!bucket) continue;
			const requests = Math.max(0, Math.round(point.value));
			bucket.statuses[status] = (bucket.statuses[status] ?? 0) + requests;
			bucket.totalRequests += requests;
		}
	}

	applySingleSeries(bucketsByTimestamp, p50Results, (bucket, value) => {
		bucket.p50ResponseTimeMs = value * 1000;
	});
	applySingleSeries(bucketsByTimestamp, p90Results, (bucket, value) => {
		bucket.p90ResponseTimeMs = value * 1000;
	});
	applySingleSeries(bucketsByTimestamp, p95Results, (bucket, value) => {
		bucket.p95ResponseTimeMs = value * 1000;
	});
	applySingleSeries(bucketsByTimestamp, p99Results, (bucket, value) => {
		bucket.p99ResponseTimeMs = value * 1000;
	});
	applySingleSeries(bucketsByTimestamp, ingressResults, (bucket, value) => {
		bucket.ingressBytesPerSecond = value;
	});
	applySingleSeries(bucketsByTimestamp, egressResults, (bucket, value) => {
		bucket.egressBytesPerSecond = value;
	});
	applySingleSeries(bucketsByTimestamp, cpuResults, (bucket, value) => {
		bucket.cpuUsagePercent = value;
	});
	applySingleSeries(
		bucketsByTimestamp,
		memoryPercentResults,
		(bucket, value) => {
			bucket.memoryUsagePercent = value;
		},
	);
	applySingleSeries(bucketsByTimestamp, memoryBytesResults, (bucket, value) => {
		bucket.memoryUsedBytes = value;
	});

	return {
		metricsEnabled: true,
		range: options.range,
		windowStart: window.start.toISOString(),
		windowEnd: window.end.toISOString(),
		stepSeconds: window.stepSeconds,
		totalRequests: buckets.reduce(
			(total, bucket) => total + bucket.totalRequests,
			0,
		),
		statusCodes: sortStatusCodes([...statusCodes]),
		buckets,
	};
}

async function queryInstantMetric(
	endpoint: EndpointConfig,
	metricName: string,
	serverId: string,
) {
	const url = new URL(`${endpoint.url}/api/v1/query`);
	url.searchParams.set(
		"query",
		`${metricName}{server_id="${escapePromQL(serverId)}"}`,
	);

	const response = await fetch(url.toString(), buildFetchOptions(endpoint));
	if (!response.ok) {
		throw new Error(
			`Failed to query metrics: ${response.status} ${response.statusText}`,
		);
	}

	const data = (await response.json()) as VictoriaInstantResponse;
	if (data.status !== "success") {
		throw new Error(data.error || "Failed to query metrics");
	}

	const rawValue = data.data?.result?.[0]?.value?.[1];
	if (rawValue === undefined) return null;
	const value = Number.parseFloat(rawValue);
	return Number.isFinite(value) ? value : null;
}

async function queryInstantMetricGroup(
	endpoint: EndpointConfig,
	metricName: string,
): Promise<Map<string, number | null>> {
	const url = new URL(`${endpoint.url}/api/v1/query`);
	url.searchParams.set("query", metricName);

	const response = await fetch(url.toString(), buildFetchOptions(endpoint));
	if (!response.ok) {
		throw new Error(
			`Failed to query metrics: ${response.status} ${response.statusText}`,
		);
	}

	const data = (await response.json()) as VictoriaInstantResponse;
	if (data.status !== "success") {
		throw new Error(data.error || "Failed to query metrics");
	}

	const byServer = new Map<string, number | null>();
	for (const res of data.data?.result ?? []) {
		const serverId = res.metric?.server_id;
		if (!serverId) continue;
		const rawValue = res.value?.[1];
		if (rawValue === undefined) {
			byServer.set(serverId, null);
			continue;
		}
		const value = Number.parseFloat(rawValue);
		byServer.set(serverId, Number.isFinite(value) ? value : null);
	}
	return byServer;
}

async function queryRangeMetric(
	endpoint: EndpointConfig,
	options: {
		metricName: string;
		serverId: string;
		start: Date;
		end: Date;
		stepSeconds: number;
	},
): Promise<NodeMetricPoint[]> {
	const url = new URL(`${endpoint.url}/api/v1/query_range`);
	url.searchParams.set(
		"query",
		`${options.metricName}{server_id="${escapePromQL(options.serverId)}"}`,
	);
	url.searchParams.set(
		"start",
		String(Math.floor(options.start.getTime() / 1000)),
	);
	url.searchParams.set("end", String(Math.floor(options.end.getTime() / 1000)));
	url.searchParams.set("step", String(options.stepSeconds));

	const response = await fetch(url.toString(), buildFetchOptions(endpoint));
	if (!response.ok) {
		throw new Error(
			`Failed to query metrics range: ${response.status} ${response.statusText}`,
		);
	}

	const data = (await response.json()) as VictoriaMatrixResponse;
	if (data.status !== "success") {
		throw new Error(data.error || "Failed to query metrics range");
	}

	return (data.data?.result?.[0]?.values ?? [])
		.map(([timestamp, rawValue]) => ({
			timestamp: new Date(timestamp * 1000).toISOString(),
			value: Number.parseFloat(rawValue),
		}))
		.filter((point) => Number.isFinite(point.value));
}

async function queryRangeMetricGroup(
	endpoint: EndpointConfig,
	options: {
		metricName: string;
		start: Date;
		end: Date;
		stepSeconds: number;
	},
): Promise<Map<string, NodeMetricPoint[]>> {
	const url = new URL(`${endpoint.url}/api/v1/query_range`);
	url.searchParams.set("query", options.metricName);
	url.searchParams.set(
		"start",
		String(Math.floor(options.start.getTime() / 1000)),
	);
	url.searchParams.set("end", String(Math.floor(options.end.getTime() / 1000)));
	url.searchParams.set("step", String(options.stepSeconds));

	const response = await fetch(url.toString(), buildFetchOptions(endpoint));
	if (!response.ok) {
		throw new Error(
			`Failed to query metrics range group: ${response.status} ${response.statusText}`,
		);
	}

	const data = (await response.json()) as VictoriaMatrixResponse;
	if (data.status !== "success") {
		throw new Error(data.error || "Failed to query metrics range group");
	}

	const byServer = new Map<string, NodeMetricPoint[]>();
	for (const result of data.data?.result ?? []) {
		const serverId = result.metric.server_id;
		if (!serverId) continue;
		byServer.set(
			serverId,
			result.values
				.map(([timestamp, rawValue]) => ({
					timestamp: new Date(timestamp * 1000).toISOString(),
					value: Number.parseFloat(rawValue),
				}))
				.filter((point) => Number.isFinite(point.value)),
		);
	}
	return byServer;
}

async function queryRangePromQL(
	endpoint: EndpointConfig,
	options: {
		query: string;
		start: Date;
		end: Date;
		stepSeconds: number;
	},
): Promise<VictoriaMatrixResult[]> {
	const url = new URL(`${endpoint.url}/api/v1/query_range`);
	url.searchParams.set("query", options.query);
	url.searchParams.set(
		"start",
		String(Math.floor(options.start.getTime() / 1000)),
	);
	url.searchParams.set("end", String(Math.floor(options.end.getTime() / 1000)));
	url.searchParams.set("step", String(options.stepSeconds));

	const response = await fetch(url.toString(), buildFetchOptions(endpoint));
	if (!response.ok) {
		throw new Error(
			`Failed to query metrics range: ${response.status} ${response.statusText}`,
		);
	}

	const data = (await response.json()) as VictoriaMatrixResponse;
	if (data.status !== "success") {
		throw new Error(data.error || "Failed to query metrics range");
	}

	return data.data?.result ?? [];
}

export function emptyHistory(): NodeMetricsHistory {
	return {
		cpuUsagePercent: [],
		memoryUsagePercent: [],
		memoryUsedBytes: [],
		diskUsagePercent: [],
		diskUsedBytes: [],
	};
}

export function getMetricWindow(
	range: MetricRange,
	now = new Date(),
): {
	start: Date;
	end: Date;
	durationMs: number;
	stepSeconds: number;
} {
	const option = METRIC_RANGE_OPTIONS[range];
	const stepMs = option.stepSeconds * SECOND_IN_MILLISECONDS;
	const end = new Date(Math.floor(getTimestamp(now) / stepMs) * stepMs);
	const start = subtractMilliseconds(end, option.durationMs);
	return {
		start,
		end,
		durationMs: option.durationMs,
		stepSeconds: option.stepSeconds,
	};
}

export function buildTraefikServiceMatcher(serviceId: string): string {
	return `^${escapePromRegex(serviceId)}(@file)?$`;
}

export function formatPromDuration(seconds: number): string {
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

function responseTimeQuery(
	quantile: number,
	traefikFilter: string,
	rangeWindow: string,
) {
	return `histogram_quantile(${quantile}, sum by (le) (rate(traefik_service_request_duration_seconds_bucket{${traefikFilter}}[${rangeWindow}])))`;
}

function createServiceMetricBuckets(window: {
	start: Date;
	end: Date;
	stepSeconds: number;
}): ServiceMetricsBucket[] {
	const buckets: ServiceMetricsBucket[] = [];
	const stepMs = window.stepSeconds * SECOND_IN_MILLISECONDS;
	const endMs = window.end.getTime();
	for (
		let timestampMs = window.start.getTime() + stepMs;
		timestampMs <= endMs;
		timestampMs += stepMs
	) {
		buckets.push({
			timestamp: new Date(timestampMs).toISOString(),
			totalRequests: 0,
			statuses: {},
			p50ResponseTimeMs: null,
			p90ResponseTimeMs: null,
			p95ResponseTimeMs: null,
			p99ResponseTimeMs: null,
			ingressBytesPerSecond: null,
			egressBytesPerSecond: null,
			cpuUsagePercent: null,
			memoryUsagePercent: null,
			memoryUsedBytes: null,
		});
	}
	return buckets;
}

function applySingleSeries(
	bucketsByTimestamp: Map<string, ServiceMetricsBucket>,
	results: VictoriaMatrixResult[],
	apply: (bucket: ServiceMetricsBucket, value: number) => void,
) {
	const result = results[0];
	if (!result) return;
	for (const point of matrixResultToPoints(result)) {
		const bucket = bucketsByTimestamp.get(point.timestamp);
		if (!bucket) continue;
		apply(bucket, point.value);
	}
}

function matrixResultToPoints(result: {
	values: Array<[number, string]>;
}): NodeMetricPoint[] {
	return result.values
		.map(([timestamp, rawValue]) => ({
			timestamp: new Date(timestamp * 1000).toISOString(),
			value: Number.parseFloat(rawValue),
		}))
		.filter((point) => Number.isFinite(point.value));
}

function sortStatusCodes(statuses: string[]): string[] {
	const statusOrder = new Map([
		["2xx", 0],
		["3xx", 1],
		["4xx", 2],
		["5xx", 3],
		["unknown", 4],
	]);

	return Array.from(new Set(statuses)).sort((a, b) => {
		const orderA = statusOrder.get(a);
		const orderB = statusOrder.get(b);
		if (orderA !== undefined && orderB !== undefined) {
			return orderA - orderB;
		}
		if (orderA !== undefined) return -1;
		if (orderB !== undefined) return 1;

		const statusA = Number(a);
		const statusB = Number(b);
		if (Number.isFinite(statusA) && Number.isFinite(statusB)) {
			return statusA - statusB;
		}
		return a.localeCompare(b);
	});
}

function normalizeHTTPStatusFamily(code: string | undefined): string {
	if (!code || !/^[2-5]\d\d$/.test(code)) return "unknown";
	return `${code.charAt(0)}xx`;
}

function escapePromQL(value: string) {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n");
}

function escapePromRegex(value: string) {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
