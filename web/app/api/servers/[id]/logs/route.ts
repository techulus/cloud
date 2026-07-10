import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
	DEFAULT_LOG_TIME_RANGE,
	isLogTimeRange,
	normalizeLogSearch,
} from "@/lib/log-query";
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
	let search: string | undefined;
	try {
		search = normalizeLogSearch(url.searchParams.get("q"));
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
	const limit = Math.min(
		Number.parseInt(url.searchParams.get("limit") || "500", 10),
		1000,
	);
	const before = url.searchParams.get("before") || undefined;

	try {
		const result = await queryLogsByServer({
			serverId,
			limit,
			before,
			search,
			range: rangeParam,
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
