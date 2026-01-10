import { auth } from "@/lib/auth";
import { headers } from "next/headers";
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
	const limit = Math.min(
		Number.parseInt(url.searchParams.get("limit") || "100", 10),
		1000,
	);
	const before = url.searchParams.get("before") || undefined;

	try {
		const result = await queryLogsByService({
			serviceId,
			limit,
			before,
			logType: "http",
		});

		const logs = result.logs.map((log) => ({
			id: `${log.service_id}-${log._time}`,
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
		return Response.json({ logs: [], hasMore: false });
	}
}
