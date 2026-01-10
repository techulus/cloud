import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import {
	isLoggingEnabled,
	queryLogsByService,
	type LogType,
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
	const limit = Math.min(
		Number.parseInt(url.searchParams.get("limit") || "100", 10),
		1000,
	);
	const before = url.searchParams.get("before") || undefined;
	const logTypeParam = url.searchParams.get("type");
	const logType =
		logTypeParam === "container" || logTypeParam === "http"
			? (logTypeParam as LogType)
			: undefined;

	try {
		const result = await queryLogsByService(serviceId, limit, before, logType);

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
		return Response.json({ logs: [], hasMore: false });
	}
}
