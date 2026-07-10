import { type LogTimeRange, normalizeLogSearch } from "@/lib/log-query";

const VICTORIA_LOGS_URL = process.env.VICTORIA_LOGS_URL;
const VICTORIA_LOGS_PRIVATE_URL = process.env.VICTORIA_LOGS_PRIVATE_URL;

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

function formatLogSqlExactFilter(field: string, value: string): string {
	const trimmed = value.trim();
	if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
		throw new Error(`Invalid ${field} filter value`);
	}

	return `${field}:${trimmed}`;
}

export function formatLogSqlSearchFilter(
	value: string | null | undefined,
	fields: readonly string[] = ["_msg"],
): string | undefined {
	const search = normalizeLogSearch(value);
	if (!search) return undefined;

	const pattern = `(?i)${search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
	const quotedPattern = JSON.stringify(pattern);
	const filters = fields.map((field) => {
		if (!/^[a-zA-Z0-9_.-]+$/.test(field)) {
			throw new Error(`Invalid log search field: ${field}`);
		}
		return `${field}:~${quotedPattern}`;
	});

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
};

export async function queryLogsByService(
	options: QueryLogsByServiceOptions,
): Promise<{ logs: StoredLog[]; hasMore: boolean }> {
	const { serviceId, limit, after, before, logType, serverId, search, range } =
		options;

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
	if (range) {
		query += ` _time:${range}`;
	}
	if (after) {
		query += ` _time:>${after}`;
	}
	if (before) {
		query += ` _time:<${before}`;
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
	if (before) {
		query += ` _time:<${before}`;
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
