import { auth } from "@/lib/auth";
import { headers } from "next/headers";
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
	const limit = Math.min(
		Number.parseInt(url.searchParams.get("limit") || "500", 10),
		1000,
	);
	const after = url.searchParams.get("after") || undefined;

	try {
		const result = await queryLogsByServer(serverId, limit, after);

		const logs = result.logs.map((log, index) => ({
			id: `${log.server_id}-${log._time}-${index}`,
			message: log._msg,
			timestamp: log._time,
			level: log.level,
		}));

		return Response.json({
			logs,
			hasMore: result.hasMore,
		});
	} catch (error) {
		console.error("[logs:server] failed to query logs:", error);
		return Response.json({ logs: [], hasMore: false });
	}
}
