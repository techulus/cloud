import {
	DEFAULT_LOG_TIME_RANGE,
	escapeLogRegex,
	type LogTimeRange,
	normalizeLogCursor,
	normalizeLogSearch,
} from "@/lib/log-query";
import {
	buildFetchOptions,
	type EndpointConfig,
	parseEndpoint,
} from "@/lib/victoria";

const VICTORIA_LOGS_URL = process.env.VICTORIA_LOGS_URL;
const VICTORIA_LOGS_PRIVATE_URL = process.env.VICTORIA_LOGS_PRIVATE_URL;

function getQueryEndpoint(): EndpointConfig | undefined {
	const endpoint = VICTORIA_LOGS_PRIVATE_URL || VICTORIA_LOGS_URL;
	if (!endpoint) return undefined;
	return parseEndpoint(endpoint);
}

export type LogType = "container" | "http";
type LogSearchField = "_msg" | "path" | "method" | "status" | "client_ip";

export type StoredLog = {
	_msg: string;
	_time: string;
	event_id?: string;
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

const publicServiceLogEventIdPattern = /^e[0-9]{19}[a-z]{26}$/;

export function isPublicServiceLogEventId(value: unknown): value is string {
	return (
		typeof value === "string" && publicServiceLogEventIdPattern.test(value)
	);
}

export class ServiceLogCursorUnavailableError extends Error {
	constructor() {
		super(
			"Log following requires current agents; upgrade agents before continuing",
		);
		this.name = "ServiceLogCursorUnavailableError";
	}
}

export function isLoggingEnabled(): boolean {
	return !!(VICTORIA_LOGS_PRIVATE_URL || VICTORIA_LOGS_URL);
}

function formatLogSqlExactFilter(field: string, value: string): string {
	const trimmed = value.trim();
	if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
		throw new Error(`Invalid ${field} filter value`);
	}

	return `${field}:${trimmed}`;
}

export function formatLogSqlSearchFilter(
	value: string | null | undefined,
	fields: readonly LogSearchField[] = ["_msg"],
): string | undefined {
	const search = normalizeLogSearch(value);
	if (!search) return undefined;

	const pattern = `(?i)${escapeLogRegex(search)}`;
	const quotedPattern = JSON.stringify(pattern);
	const filters = fields.map((field) => `${field}:~${quotedPattern}`);

	return filters.length === 1 ? filters[0] : `(${filters.join(" OR ")})`;
}

type QueryLogsByServiceOptions = {
	serviceId: string;
	limit: number;
	after?: string;
	before?: string;
	logType?: LogType;
	serverId?: string;
	search?: string;
	range?: LogTimeRange;
	signal?: AbortSignal;
};

export type PublicServiceLogCursor = {
	time: string;
	eventId: string;
};

type PublicServiceLogsOptions = Omit<
	QueryLogsByServiceOptions,
	"after" | "before"
> & {
	cursor?: PublicServiceLogCursor;
};

function buildServiceLogFilter(options: QueryLogsByServiceOptions): string {
	const { serviceId, logType, serverId, search, range } = options;
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
	if (range) {
		query += ` _time:${range}`;
	}
	const searchFilter = formatLogSqlSearchFilter(
		search,
		logType === "http"
			? ["_msg", "path", "method", "status", "client_ip"]
			: ["_msg"],
	);
	if (searchFilter) {
		query += ` ${searchFilter}`;
	}
	return query;
}

function providerSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(5_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchLogQuery(
	endpoint: EndpointConfig,
	query: string,
	signal?: AbortSignal,
): Promise<StoredLog[]> {
	const url = new URL(`${endpoint.url}/select/logsql/query`);
	url.searchParams.set("query", query);
	url.searchParams.set("timeout", "4s");
	const response = await fetch(url.toString(), {
		...buildFetchOptions(endpoint),
		signal: providerSignal(signal),
	});

	if (!response.ok) {
		throw new Error(
			`Failed to query logs: ${response.status} ${response.statusText}`,
		);
	}

	const text = await response.text();
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as StoredLog);
}

function deduplicateIdentifiedLogs(logs: StoredLog[]): StoredLog[] {
	const seen = new Set<string>();
	return logs.filter((log) => {
		if (!log.event_id) return true;
		if (seen.has(log.event_id)) return false;
		seen.add(log.event_id);
		return true;
	});
}

export async function queryPublicServiceLogs(
	options: PublicServiceLogsOptions,
): Promise<{ logs: StoredLog[]; hasMore: boolean }> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	const pageSize = options.limit + 1;
	let query = buildServiceLogFilter({
		...options,
		range: options.range ?? DEFAULT_LOG_TIME_RANGE,
	});
	if (options.cursor) {
		const cursorTime = normalizeLogCursor(options.cursor.time);
		if (!cursorTime) throw new Error("Invalid public service log cursor time");
		if (
			options.cursor.eventId !== "" &&
			!isPublicServiceLogEventId(options.cursor.eventId)
		) {
			throw new Error("Invalid public service log cursor event ID");
		}
		if (options.cursor.eventId) {
			const eventId = JSON.stringify(options.cursor.eventId);
			query += ` (_time:>${cursorTime} OR (_time:>=${cursorTime} _time:<=${cursorTime} event_id:>${eventId}))`;
		} else {
			query += ` _time:>=${cursorTime}`;
		}
		query += ` | first ${pageSize} by (_time, event_id)`;
	} else {
		query += ` | first ${pageSize} by (_time desc, event_id desc) | sort by (_time, event_id)`;
	}

	const rawLogs = await fetchLogQuery(endpoint, query, options.signal);
	if (
		options.cursor &&
		rawLogs.some((log) => !isPublicServiceLogEventId(log.event_id))
	) {
		throw new ServiceLogCursorUnavailableError();
	}
	const logs = deduplicateIdentifiedLogs(rawLogs);
	const hasMore =
		options.cursor !== undefined &&
		(rawLogs.length > options.limit || logs.length > options.limit);
	if (logs.length > options.limit) {
		if (options.cursor) logs.pop();
		else logs.shift();
	}
	return { logs, hasMore };
}

export async function queryLogsByService(
	options: QueryLogsByServiceOptions,
): Promise<{ logs: StoredLog[]; hasMore: boolean }> {
	const { limit, after, before } = options;

	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	let query = buildServiceLogFilter(options);
	const afterCursor = normalizeLogCursor(after);
	if (afterCursor) {
		query += ` _time:>${afterCursor}`;
	}
	const beforeCursor = normalizeLogCursor(before);
	if (beforeCursor) {
		query += ` _time:<${beforeCursor}`;
	}
	query += " | sort by (_time desc)";

	const url = new URL(`${endpoint.url}/select/logsql/query`);
	url.searchParams.set("query", query);
	url.searchParams.set("limit", String(limit + 1));

	const response = await fetch(url.toString(), {
		...buildFetchOptions(endpoint),
		signal: providerSignal(options.signal),
	});

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
	after?: string,
): Promise<{ logs: StoredLog[]; hasMore: boolean }> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	let query = formatLogSqlExactFilter("deployment_id", deploymentId);
	const afterCursor = normalizeLogCursor(after);
	if (afterCursor) {
		query += ` _time:>${afterCursor}`;
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

type QueryLogsByServerOptions = {
	serverId: string;
	limit?: number;
	before?: string;
	search?: string;
	range?: LogTimeRange;
};

export async function queryLogsByServer({
	serverId,
	limit = 500,
	before,
	search,
	range,
}: QueryLogsByServerOptions): Promise<{
	logs: AgentLog[];
	hasMore: boolean;
}> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	let query = `${formatLogSqlExactFilter("server_id", serverId)} log_type:agent`;
	if (range) {
		query += ` _time:${range}`;
	}
	const beforeCursor = normalizeLogCursor(before);
	if (beforeCursor) {
		query += ` _time:<${beforeCursor}`;
	}
	const searchFilter = formatLogSqlSearchFilter(search);
	if (searchFilter) {
		query += ` ${searchFilter}`;
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
	{ limit = 1000, search }: { limit?: number; search?: string } = {},
): Promise<{ logs: RolloutLog[] }> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	let query = `${formatLogSqlExactFilter("rollout_id", rolloutId)} log_type:rollout`;
	const searchFilter = formatLogSqlSearchFilter(search);
	if (searchFilter) {
		query += ` ${searchFilter}`;
	}
	query += " | sort by (_time)";

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
	{ limit = 1000, search }: { limit?: number; search?: string } = {},
): Promise<{ logs: BuildLog[] }> {
	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	let query = `${formatLogSqlExactFilter("build_id", buildId)} log_type:build`;
	const searchFilter = formatLogSqlSearchFilter(search);
	if (searchFilter) {
		query += ` ${searchFilter}`;
	}
	query += " | sort by (_time)";

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
