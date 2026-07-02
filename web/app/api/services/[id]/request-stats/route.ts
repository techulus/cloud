import { headers } from "next/headers";
import { getService } from "@/db/queries";
import { auth } from "@/lib/auth";
import {
	createEmptyHttpRequestStats,
	isLoggingEnabled,
	parseRequestStatsRange,
	queryHttpRequestStats,
} from "@/lib/victoria-logs";

const SERVICE_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

	if (!SERVICE_ID_PATTERN.test(serviceId)) {
		return Response.json({ message: "Invalid service id" }, { status: 400 });
	}

	const service = await getService(serviceId);
	if (!service) {
		return Response.json({ message: "Service not found" }, { status: 404 });
	}

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
		return Response.json(
			{ message: "Request stats unavailable" },
			{ status: 502 },
		);
	}
}
