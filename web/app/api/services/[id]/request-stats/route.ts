import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
	createEmptyHttpRequestStats,
	isLoggingEnabled,
	parseRequestStatsRange,
	queryHttpRequestStats,
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

	const { id: serviceId } = await params;
	const url = new URL(request.url);
	const range = parseRequestStatsRange(url.searchParams.get("range"));

	if (!isLoggingEnabled()) {
		return Response.json({
			loggingEnabled: false,
			...createEmptyHttpRequestStats(range),
		});
	}

	try {
		const stats = await queryHttpRequestStats({ serviceId, range });
		return Response.json({ loggingEnabled: true, ...stats });
	} catch (error) {
		console.error("[logs:request-stats] failed to query HTTP stats:", error);
		return Response.json({
			loggingEnabled: true,
			...createEmptyHttpRequestStats(range),
		});
	}
}
