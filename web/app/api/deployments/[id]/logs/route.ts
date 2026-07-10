import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { normalizeLogCursor, parseLogLimit } from "@/lib/log-query";
import { isLoggingEnabled, queryLogsByDeployment } from "@/lib/victoria-logs";

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

	const { id: deploymentId } = await params;
	const url = new URL(request.url);
	let limit: number;
	let after: string | undefined;
	try {
		limit = parseLogLimit(url.searchParams.get("limit"), 100);
		after = normalizeLogCursor(url.searchParams.get("after"));
	} catch (error) {
		return Response.json(
			{ message: error instanceof Error ? error.message : "Invalid request" },
			{ status: 400 },
		);
	}

	try {
		const result = await queryLogsByDeployment(deploymentId, limit, after);

		const logs = result.logs.map((log) => ({
			id: `${log.deployment_id}-${log._time}`,
			deploymentId: log.deployment_id,
			stream: log.stream,
			message: log._msg,
			timestamp: log._time,
		}));

		return Response.json({
			logs: logs.reverse(),
			hasMore: result.hasMore,
		});
	} catch (error) {
		console.error("[logs:deployment] failed to query logs:", error);
		return Response.json({ logs: [], hasMore: false });
	}
}
