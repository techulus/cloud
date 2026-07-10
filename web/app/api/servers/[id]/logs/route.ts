import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { invalidLogQueryResponse, parseLogListParams } from "@/lib/log-query";
import { isLoggingEnabled, queryLogsByServer } from "@/lib/victoria-logs";

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

	const { id: serverId } = await params;
	const url = new URL(request.url);
	let queryParams: ReturnType<typeof parseLogListParams>;
	try {
		queryParams = parseLogListParams(url.searchParams, 500);
	} catch (error) {
		return invalidLogQueryResponse(error);
	}

	try {
		const result = await queryLogsByServer({
			serverId,
			...queryParams,
		});

		const logs = result.logs.map((log, index) => ({
			id: `${log.server_id}-${log._time}-${index}`,
			message: log._msg,
			timestamp: log._time,
			level: log.level,
		}));

		return Response.json({
			logs: logs.reverse(),
			hasMore: result.hasMore,
		});
	} catch (error) {
		console.error("[logs:server] failed to query logs:", error);
		return Response.json(
			{ message: "Failed to query server logs" },
			{ status: 502 },
		);
	}
}
