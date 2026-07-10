import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { invalidLogQueryResponse, parseLogListParams } from "@/lib/log-query";
import { isLoggingEnabled, queryLogsByService } from "@/lib/victoria-logs";

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
	let queryParams: ReturnType<typeof parseLogListParams>;
	try {
		queryParams = parseLogListParams(url.searchParams, 100);
	} catch (error) {
		return invalidLogQueryResponse(error);
	}

	try {
		const result = await queryLogsByService({
			serviceId,
			...queryParams,
			logType: "http",
		});

		const logs = result.logs.map((log) => ({
			id: `${log._time}-${log.method}-${log.path}-${log.status}-${log.duration_ms}`,
			method: log.method || "GET",
			path: log.path || log._msg,
			status: log.status || 0,
			duration: log.duration_ms || 0,
			clientIp: log.client_ip || "",
			timestamp: log._time,
		}));

		return Response.json({
			logs: logs.reverse(),
			hasMore: result.hasMore,
		});
	} catch (error) {
		console.error("[logs:requests] failed to query HTTP logs:", error);
		return Response.json(
			{ message: "Failed to query request logs" },
			{ status: 502 },
		);
	}
}
