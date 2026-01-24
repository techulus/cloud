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
	return !!VICTORIA_LOGS_URL;
}

type QueryLogsByServiceOptions = {
	serviceId: string;
	limit: number;
	before?: string;
	logType?: LogType;
	serverId?: string;
};

export async function queryLogsByService(
	options: QueryLogsByServiceOptions,
): Promise<{ logs: StoredLog[]; hasMore: boolean }> {
	const { serviceId, limit, before, logType, serverId } = options;

	const endpoint = getQueryEndpoint();
	if (!endpoint) {
		throw new Error("VICTORIA_LOGS_URL is not configured");
	}

	let query = `service_id:${serviceId}`;
	if (logType === "http") {
		query += ` log_type:http`;
	} else if (logType === "container") {
		query += ` -log_type:http`;
	}
	if (serverId) {
		query += ` server_id:${serverId}`;
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

	let query = `deployment_id:${deploymentId}`;
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

	let query = `server_id:${serverId} log_type:agent`;
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
