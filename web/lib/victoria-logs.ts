const VICTORIA_LOGS_URL = process.env.VICTORIA_LOGS_URL;

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

export async function queryLogsByService(
  serviceId: string,
  limit: number,
  after?: string,
  logType?: LogType
): Promise<{ logs: StoredLog[]; hasMore: boolean }> {
  if (!VICTORIA_LOGS_URL) {
    throw new Error("VICTORIA_LOGS_URL is not configured");
  }

  let query = `service_id:${serviceId}`;
  if (logType === "http") {
    query += ` log_type:http`;
  } else if (logType === "container") {
    query += ` -log_type:http`;
  }
  if (after) {
    query += ` _time:>${after}`;
  }

  const url = new URL(`${VICTORIA_LOGS_URL}/select/logsql/query`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit + 1));

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Failed to query logs: ${response.status} ${response.statusText}`);
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
  after?: string
): Promise<{ logs: StoredLog[]; hasMore: boolean }> {
  if (!VICTORIA_LOGS_URL) {
    throw new Error("VICTORIA_LOGS_URL is not configured");
  }

  let query = `deployment_id:${deploymentId}`;
  if (after) {
    query += ` _time:>${after}`;
  }

  const url = new URL(`${VICTORIA_LOGS_URL}/select/logsql/query`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit + 1));

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Failed to query logs: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const lines = text.trim().split("\n").filter(Boolean);
  const logs = lines.map((line) => JSON.parse(line) as StoredLog);

  const hasMore = logs.length > limit;
  if (hasMore) logs.pop();

  return { logs, hasMore };
}
