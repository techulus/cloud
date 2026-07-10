import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
	DEFAULT_LOG_TIME_RANGE,
	isLogTimeRange,
	normalizeLogCursor,
	normalizeLogSearch,
	parseLogLimit,
} from "@/lib/log-query";
import {
	isLoggingEnabled,
	type LogType,
	queryLogsByService,
} from "@/lib/victoria-logs";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return new Response("Unauthorized", { status: 401 });
	}

	if (!isLoggingEnabled()) {
		return Response.json({ logs: [], hasMore: false });
	}

	const { id: serviceId } = await params;
	const url = new URL(request.url);
	let search: string | undefined;
	let before: string | undefined;
	let limit: number;
	try {
		search = normalizeLogSearch(url.searchParams.get("q"));
		before = normalizeLogCursor(url.searchParams.get("before"));
		limit = parseLogLimit(url.searchParams.get("limit"), 100);
	} catch (error) {
		return Response.json(
			{ message: error instanceof Error ? error.message : "Invalid search" },
			{ status: 400 },
		);
	}
	const rangeParam = url.searchParams.get("range") || DEFAULT_LOG_TIME_RANGE;
	if (!isLogTimeRange(rangeParam)) {
		return Response.json({ message: "Invalid log range" }, { status: 400 });
	}
	const serverId = url.searchParams.get("serverId") || undefined;
	const logTypeParam = url.searchParams.get("type");
	const logType =
		logTypeParam === "container" || logTypeParam === "http"
			? (logTypeParam as LogType)
			: undefined;

	try {
		const result = await queryLogsByService({
			serviceId,
			limit,
			before,
			logType,
			serverId,
			search,
			range: rangeParam,
		});

		const logs = result.logs.map((log) => ({
			id: `${log.deployment_id || log.service_id}-${log._time}`,
			deploymentId: log.deployment_id,
			stream: log.stream || (log.log_type === "http" ? "http" : "stdout"),
			message: log._msg,
			timestamp: log._time,
			logType: log.log_type || "container",
			status: log.status,
			method: log.method,
			path: log.path,
			duration: log.duration_ms,
			clientIp: log.client_ip,
		}));

		return Response.json({
			logs: logs.reverse(),
			hasMore: result.hasMore,
		});
	} catch (error) {
		console.error("[logs:service] failed to query logs:", error);
		return Response.json(
			{ message: "Failed to query service logs" },
			{ status: 502 },
		);
	}
}
