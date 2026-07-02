const VICTORIA_LOGS_URL = process.env.VICTORIA_LOGS_URL;
const VICTORIA_LOGS_PRIVATE_URL = process.env.VICTORIA_LOGS_PRIVATE_URL;

export const REQUEST_STATS_RANGE_OPTIONS = {
	"1h": { durationMs: 60 * 60 * 1000, stepSeconds: 60, stepLogSql: "1m" },
	"6h": {
		durationMs: 6 * 60 * 60 * 1000,
		stepSeconds: 5 * 60,
		stepLogSql: "5m",
	},
	"24h": {
		durationMs: 24 * 60 * 60 * 1000,
		stepSeconds: 5 * 60,
		stepLogSql: "5m",
	},
	"7d": {
		durationMs: 7 * 24 * 60 * 60 * 1000,
		stepSeconds: 30 * 60,
		stepLogSql: "30m",
	},
	week: {
		durationMs: 0,
		stepSeconds: 30 * 60,
		stepLogSql: "30m",
		weekToDate: true,
	},
} as const;

export type RequestStatsRange = keyof typeof REQUEST_STATS_RANGE_OPTIONS;

export const DEFAULT_REQUEST_STATS_RANGE: RequestStatsRange = "7d";

type EndpointConfig = {
	url: string;
	username?: string;
	password?: string;
};

function parseEndpoint(endpoint: string): EndpointConfig {
	const parsed = new URL(endpoint);
	const username = parsed.username || undefined;
	const password = parsed.password || undefined;
	parsed.username = "";
	parsed.password = "";
	return { url: parsed.toString().replace(/\/$/, ""), username, password };
}

function getQueryEndpoint(): EndpointConfig | undefined {
	const endpoint = VICTORIA_LOGS_PRIVATE_URL || VICTORIA_LOGS_URL;
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

export type LogType = "container" | "http";

export type StoredLog = {
	_msg: string;
	_time: string;
	deployment_id?: string;
	service_id: string;
	server_id?: string;
	stream?: string;
	log_type?: string;
	host?: string;
	method?: string;
	path?: string;
	status?: number;
	duration_ms?: number;
	size?: number;
	client_ip?: string;
};

export function isLoggingEnabled(): boolean {
	return !!(VICTORIA_LOGS_PRIVATE_URL || VICTORIA_LOGS_URL);
}

export type HttpRequestStatsBucket = {
	timestamp: string;
	totalRequests: number;
	statuses: Record<string, number>;
};

export type HttpRequestStats = {
	range: RequestStatsRange;
	windowStart: string;
	windowEnd: string;
	stepSeconds: number;
	totalRequests: number;
	statusCodes: string[];
	buckets: HttpRequestStatsBucket[];
};

type RequestStatsRow = Record<string, unknown>;

export function parseRequestStatsRange(
	value: string | null | undefined,
): RequestStatsRange {
	if (value && value in REQUEST_STATS_RANGE_OPTIONS) {
		return value as RequestStatsRange;
	}
	return DEFAULT_REQUEST_STATS_RANGE;
}

export function createEmptyHttpRequestStats(
	range: RequestStatsRange = DEFAULT_REQUEST_STATS_RANGE,
	now = new Date(),
): HttpRequestStats {
	const window = getRequestStatsWindow(range, now);
	return {
		range,
		windowStart: window.start.toISOString(),
		windowEnd: window.end.toISOString(),
		stepSeconds: window.stepSeconds,
		totalRequests: 0,
		statusCodes: [],
		buckets: [],
	};
}

export function getRequestStatsWindow(
	range: RequestStatsRange,
	now = new Date(),
): {
	start: Date;
	end: Date;
	durationMs: number;
	stepSeconds: number;
	stepLogSql: string;
} {
	const config = REQUEST_STATS_RANGE_OPTIONS[range];
	const start =
		"weekToDate" in config && config.weekToDate
			? getStartOfUtcWeek(now)
			: new Date(now.getTime() - config.durationMs);

	return {
		start,
		end: now,
		durationMs: Math.max(0, now.getTime() - start.getTime()),
		stepSeconds: config.stepSeconds,
		stepLogSql: config.stepLogSql,
	};
}

export function parseRequestStatsRows(text: string): RequestStatsRow[] {
	const lines = text.trim().split("\n").filter(Boolean);
	const rows: RequestStatsRow[] = [];

	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				rows.push(parsed as RequestStatsRow);
			}
		} catch {
			// VictoriaLogs should return JSON lines, but a single malformed row should
			// not break the service overview card.
		}
	}

	return rows;
}

export function buildRequestStatsBuckets(
	rows: RequestStatsRow[],
	options: { start: Date; end: Date; stepSeconds: number },
): HttpRequestStatsBucket[] {
	const stepMs = options.stepSeconds * 1000;
	const startMs = floorToStep(options.start.getTime(), stepMs);
	const endMs = floorToStep(options.end.getTime(), stepMs);

	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
		return [];
	}

	const byBucket = new Map<
		number,
		{ totalRequests: number; statuses: Record<string, number> }
	>();
	for (const row of rows) {
		const timestamp = parseTimestamp(row._time ?? row.time ?? row.timestamp);
		if (!timestamp) continue;

		const bucketMs = floorToStep(timestamp.getTime(), stepMs);
		const bucket = byBucket.get(bucketMs) ?? {
			totalRequests: 0,
			statuses: {},
		};
		const requests = parseStatNumber(row.requests);
		const status = normalizeStatus(row.status);
		bucket.totalRequests += requests;
		bucket.statuses[status] = (bucket.statuses[status] ?? 0) + requests;
		byBucket.set(bucketMs, bucket);
	}

	const buckets: HttpRequestStatsBucket[] = [];
	for (let timestampMs = startMs; timestampMs <= endMs; timestampMs += stepMs) {
		const bucket = byBucket.get(timestampMs) ?? {
			totalRequests: 0,
			statuses: {},
		};
		buckets.push({
			timestamp: new Date(timestampMs).toISOString(),
			totalRequests: bucket.totalRequests,
			statuses: bucket.statuses,
		});
	}

	return buckets;
}

export async function queryHttpRequestStats(options: {
	serviceId: string;
	range: RequestStatsRange;
	now?: Date;
}): Promise<HttpRequestStats> {
	const now = options.now ?? new Date();
	const window = getRequestStatsWindow(options.range, now);
	const statusCodeLimit = 64;
	const bucketLimit =
		(Math.ceil(window.durationMs / (window.stepSeconds * 1000)) + 5) *
		statusCodeLimit;
	const baseFilter = [
		formatLogSqlExactFilter("service_id", options.serviceId),
		"log_type:http",
		formatLogSqlTimeRange(window.start, window.end),
	].join(" ");
	const bucketQuery = `${baseFilter} | stats by (_time:${window.stepLogSql}, status) count() as requests | sort by (_time)`;

	const bucketText = await queryLogSql(bucketQuery, bucketLimit);

	const buckets = buildRequestStatsBuckets(parseRequestStatsRows(bucketText), {
		start: window.start,
		end: window.end,
		stepSeconds: window.stepSeconds,
	});
	const statusCodes = sortStatusCodes([
		...buckets.flatMap((bucket) => Object.keys(bucket.statuses)),
	]);

	return {
		range: options.range,
		windowStart: window.start.toISOString(),
		windowEnd: window.end.toISOString(),
		stepSeconds: window.stepSeconds,
		totalRequests: buckets.reduce(
			(sum, bucket) => sum + bucket.totalRequests,
			0,
		),
		statusCodes,
		buckets,
	};
}

async function queryLogSql(query: string, limit: number): Promise<string> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	const url = new URL(`${endpoint.url}/select/logsql/query`);
	url.searchParams.set("query", query);
	url.searchParams.set("limit", String(limit));

	const response = await fetch(url.toString(), buildFetchOptions(endpoint));

	if (!response.ok) {
		throw new Error(
			`Failed to query logs: ${response.status} ${response.statusText}`,
		);
	}

	return response.text();
}

function parseStatNumber(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function normalizeStatus(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	if (typeof value === "string" && value.trim() !== "") {
		return value.trim();
	}
	return "unknown";
}

function sortStatusCodes(statuses: string[]): string[] {
	return Array.from(new Set(statuses)).sort((a, b) => {
		const statusA = Number(a);
		const statusB = Number(b);
		if (Number.isFinite(statusA) && Number.isFinite(statusB)) {
			return statusA - statusB;
		}
		return a.localeCompare(b);
	});
}

function parseTimestamp(value: unknown): Date | null {
	if (typeof value !== "string" && typeof value !== "number") {
		return null;
	}

	const timestamp = new Date(value);
	return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

function floorToStep(timestampMs: number, stepMs: number): number {
	return Math.floor(timestampMs / stepMs) * stepMs;
}

function getStartOfUtcWeek(value: Date): Date {
	const start = new Date(
		Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
	);
	const day = start.getUTCDay();
	const daysSinceMonday = day === 0 ? 6 : day - 1;
	start.setUTCDate(start.getUTCDate() - daysSinceMonday);
	return start;
}

function formatLogSqlExactFilter(field: string, value: string): string {
	const trimmed = value.trim();
	if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
		throw new Error(`Invalid ${field} filter value`);
	}

	return `${field}:${trimmed}`;
}

function formatLogSqlTimeRange(start: Date, end: Date): string {
	return `_time:[${start.toISOString()}, ${end.toISOString()})`;
}

type QueryLogsByServiceOptions = {
	serviceId: string;
	limit: number;
	after?: string;
	before?: string;
	logType?: LogType;
	serverId?: string;
};

export async function queryLogsByService(
	options: QueryLogsByServiceOptions,
): Promise<{ logs: StoredLog[]; hasMore: boolean }> {
	const { serviceId, limit, after, before, logType, serverId } = options;

	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	let query = formatLogSqlExactFilter("service_id", serviceId);
	if (logType === "http") {
		query += ` log_type:http`;
	} else if (logType === "container") {
		query += ` -log_type:http -log_type:build -log_type:rollout`;
	} else {
		query += ` -log_type:build -log_type:rollout`;
	}
	if (serverId) {
		query += ` ${formatLogSqlExactFilter("server_id", serverId)}`;
	}
	if (after) {
		query += ` _time:>${after}`;
	}
	if (before) {
		query += ` _time:<${before}`;
	}
	query += " | sort by (_time desc)";

	const url = new URL(`${endpoint.url}/select/logsql/query`);
	url.searchParams.set("query", query);
	url.searchParams.set("limit", String(limit + 1));

	const response = await fetch(url.toString(), buildFetchOptions(endpoint));

	if (!response.ok) {
		throw new Error(
			`Failed to query logs: ${response.status} ${response.statusText}`,
		);
	}

	const text = await response.text();
	const lines = text.trim().split("\n").filter(Boolean);
	const logs = lines.map((line) => JSON.parse(line) as StoredLog);

	const hasMore = logs.length > limit;
	if (hasMore) logs.pop();

	return { logs, hasMore };
}

export async function queryLogsByDeployment(
	deploymentId: string,
	limit: number,
	before?: string,
): Promise<{ logs: StoredLog[]; hasMore: boolean }> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	let query = formatLogSqlExactFilter("deployment_id", deploymentId);
	if (before) {
		query += ` _time:<${before}`;
	}
	query += " | sort by (_time desc)";

	const url = new URL(`${endpoint.url}/select/logsql/query`);
	url.searchParams.set("query", query);
	url.searchParams.set("limit", String(limit + 1));

	const response = await fetch(url.toString(), buildFetchOptions(endpoint));

	if (!response.ok) {
		throw new Error(
			`Failed to query logs: ${response.status} ${response.statusText}`,
		);
	}

	const text = await response.text();
	const lines = text.trim().split("\n").filter(Boolean);
	const logs = lines.map((line) => JSON.parse(line) as StoredLog);

	const hasMore = logs.length > limit;
	if (hasMore) logs.pop();

	return { logs, hasMore };
}

export type BuildLog = {
	_msg: string;
	_time: string;
	build_id: string;
	service_id: string;
	project_id: string;
	log_type: "build";
};

export type AgentLog = {
	_msg: string;
	_time: string;
	server_id: string;
	level: string;
	log_type: "agent";
};

export async function queryLogsByServer(
	serverId: string,
	limit: number = 500,
	before?: string,
): Promise<{ logs: AgentLog[]; hasMore: boolean }> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	let query = `${formatLogSqlExactFilter("server_id", serverId)} log_type:agent`;
	if (before) {
		query += ` _time:<${before}`;
	}
	query += " | sort by (_time desc)";

	const url = new URL(`${endpoint.url}/select/logsql/query`);
	url.searchParams.set("query", query);
	url.searchParams.set("limit", String(limit + 1));

	const response = await fetch(url.toString(), buildFetchOptions(endpoint));

	if (!response.ok) {
		throw new Error(
			`Failed to query server logs: ${response.status} ${response.statusText}`,
		);
	}

	const text = await response.text();
	const lines = text.trim().split("\n").filter(Boolean);
	const logs = lines.map((line) => JSON.parse(line) as AgentLog);

	const hasMore = logs.length > limit;
	if (hasMore) logs.pop();

	return { logs, hasMore };
}

export type RolloutLog = {
	_msg: string;
	_time: string;
	rollout_id: string;
	service_id: string;
	stage: string;
	log_type: "rollout";
};

export async function ingestRolloutLog(
	rolloutId: string,
	serviceId: string,
	stage: string,
	message: string,
): Promise<void> {
	try {
		const endpoint = getQueryEndpoint();
		if (!endpoint) return;

		const entry: RolloutLog = {
			_msg: message,
			_time: new Date().toISOString(),
			rollout_id: rolloutId,
			service_id: serviceId,
			stage,
			log_type: "rollout",
		};

		const url = `${endpoint.url}/insert/jsonline`;
		const options = buildFetchOptions(endpoint);

		await fetch(url, {
			...options,
			method: "POST",
			body: `${JSON.stringify(entry)}\n`,
			headers: {
				...((options.headers as Record<string, string>) || {}),
				"Content-Type": "application/json",
			},
		});
	} catch (error) {
		console.error("Failed to ingest rollout log:", error);
	}
}

export async function queryLogsByRollout(
	rolloutId: string,
	limit: number = 1000,
): Promise<{ logs: RolloutLog[] }> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	const query = `${formatLogSqlExactFilter("rollout_id", rolloutId)} log_type:rollout | sort by (_time)`;

	const url = new URL(`${endpoint.url}/select/logsql/query`);
	url.searchParams.set("query", query);
	url.searchParams.set("limit", String(limit));

	const response = await fetch(url.toString(), buildFetchOptions(endpoint));

	if (!response.ok) {
		throw new Error(
			`Failed to query rollout logs: ${response.status} ${response.statusText}`,
		);
	}

	const text = await response.text();
	const lines = text.trim().split("\n").filter(Boolean);
	const logs = lines.map((line) => JSON.parse(line) as RolloutLog);

	return { logs };
}

export async function queryLogsByBuild(
	buildId: string,
	limit: number = 1000,
): Promise<{ logs: BuildLog[] }> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	const query = `build_id:${buildId} log_type:build | sort by (_time)`;

	const url = new URL(`${endpoint.url}/select/logsql/query`);
	url.searchParams.set("query", query);
	url.searchParams.set("limit", String(limit));

	const response = await fetch(url.toString(), buildFetchOptions(endpoint));

	if (!response.ok) {
		throw new Error(
			`Failed to query build logs: ${response.status} ${response.statusText}`,
		);
	}

	const text = await response.text();
	const lines = text.trim().split("\n").filter(Boolean);
	const logs = lines.map((line) => JSON.parse(line) as BuildLog);

	return { logs };
}
