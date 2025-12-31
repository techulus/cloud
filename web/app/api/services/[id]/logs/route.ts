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
	const after = url.searchParams.get("after") || undefined;

	try {
		const result = await queryLogsByService(serviceId, limit, after);

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
		console.error("[logs:service] failed to query logs:", error);
		return Response.json({ logs: [], hasMore: false });
	}
}
