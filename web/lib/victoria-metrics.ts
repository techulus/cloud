const VICTORIA_METRICS_URL = process.env.VICTORIA_METRICS_URL;
const VICTORIA_METRICS_PRIVATE_URL = process.env.VICTORIA_METRICS_PRIVATE_URL;

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

type VictoriaMatrixResponse = {
	status: string;
	data?: {
		result?: Array<{
			metric: Record<string, string>;
			values: Array<[number, string]>;
		}>;
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

export type NodeMetricsHistory = {
	cpuUsagePercent: NodeMetricPoint[];
	memoryUsagePercent: NodeMetricPoint[];
	memoryUsedBytes: NodeMetricPoint[];
	diskUsagePercent: NodeMetricPoint[];
	diskUsedBytes: NodeMetricPoint[];
};

export type MetricsHistory = NodeMetricsHistory;

export const METRIC_RANGE_OPTIONS = {
	"1h": { durationMs: 60 * 60 * 1000, stepSeconds: 60 },
	"6h": { durationMs: 6 * 60 * 60 * 1000, stepSeconds: 60 },
	"24h": { durationMs: 24 * 60 * 60 * 1000, stepSeconds: 5 * 60 },
	"7d": { durationMs: 7 * 24 * 60 * 60 * 1000, stepSeconds: 30 * 60 },
	"30d": { durationMs: 30 * 24 * 60 * 60 * 1000, stepSeconds: 2 * 60 * 60 },
} as const;

export type MetricRange = keyof typeof METRIC_RANGE_OPTIONS;

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
	const endpoint = VICTORIA_METRICS_PRIVATE_URL || VICTORIA_METRICS_URL;
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

export function parseMetricRange(value: string | null): MetricRange {
	if (value && value in METRIC_RANGE_OPTIONS) {
		return value as MetricRange;
	}
	return "1h";
}

export function isMetricsEnabled(): boolean {
	return !!(VICTORIA_METRICS_PRIVATE_URL || VICTORIA_METRICS_URL);
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

export async function queryClusterMetricsSnapshot(): Promise<NodeMetricsSnapshot | null> {
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
			const value = await queryInstantAggregateMetric(endpoint, {
				metricName,
				aggregation: isByteMetric(key) ? "sum" : "avg",
			}).catch(() => null);
			snapshot[key as keyof NodeMetricsSnapshot] = value;
		}),
	);

	return snapshot;
}

export async function queryClusterMetricsHistory(options: {
	start: Date;
	end: Date;
	stepSeconds: number;
}): Promise<MetricsHistory> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) return emptyHistory();

	const entries = await Promise.all(
		Object.entries(METRIC_NAMES).map(async ([key, metricName]) => {
			const series = await queryRangeAggregateMetric(endpoint, {
				metricName,
				aggregation: isByteMetric(key) ? "sum" : "avg",
				start: options.start,
				end: options.end,
				stepSeconds: options.stepSeconds,
			}).catch(() => []);
			return [key, series] as const;
		}),
	);

	return Object.fromEntries(entries) as MetricsHistory;
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

async function queryInstantAggregateMetric(
	endpoint: EndpointConfig,
	options: {
		metricName: string;
		aggregation: "avg" | "sum";
	},
) {
	const url = new URL(`${endpoint.url}/api/v1/query`);
	url.searchParams.set(
		"query",
		`${options.aggregation}(${options.metricName})`,
	);

	const response = await fetch(url.toString(), buildFetchOptions(endpoint));
	if (!response.ok) {
		throw new Error(
			`Failed to query aggregate metrics: ${response.status} ${response.statusText}`,
		);
	}

	const data = (await response.json()) as VictoriaInstantResponse;
	if (data.status !== "success") {
		throw new Error(data.error || "Failed to query aggregate metrics");
	}

	const rawValue = data.data?.result?.[0]?.value?.[1];
	if (rawValue === undefined) return null;
	const value = Number.parseFloat(rawValue);
	return Number.isFinite(value) ? value : null;
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

async function queryRangeAggregateMetric(
	endpoint: EndpointConfig,
	options: {
		metricName: string;
		aggregation: "avg" | "sum";
		start: Date;
		end: Date;
		stepSeconds: number;
	},
): Promise<NodeMetricPoint[]> {
	const url = new URL(`${endpoint.url}/api/v1/query_range`);
	url.searchParams.set(
		"query",
		`${options.aggregation}(${options.metricName})`,
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
			`Failed to query aggregate metrics range: ${response.status} ${response.statusText}`,
		);
	}

	const data = (await response.json()) as VictoriaMatrixResponse;
	if (data.status !== "success") {
		throw new Error(data.error || "Failed to query aggregate metrics range");
	}

	return (data.data?.result?.[0]?.values ?? [])
		.map(([timestamp, rawValue]) => ({
			timestamp: new Date(timestamp * 1000).toISOString(),
			value: Number.parseFloat(rawValue),
		}))
		.filter((point) => Number.isFinite(point.value));
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

function escapePromQL(value: string) {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n");
}

function isByteMetric(key: string) {
	return key === "memoryUsedBytes" || key === "diskUsedBytes";
}
