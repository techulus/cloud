import { headers } from "next/headers";
import { getService } from "@/db/queries";
import { auth } from "@/lib/auth";
import {
	createEmptyServiceMetrics,
	isMetricsEnabled,
	parseMetricRange,
	queryServiceMetrics,
	warnMissingMetricsConfig,
} from "@/lib/victoria-metrics";

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
	const range = parseMetricRange(url.searchParams.get("range"));

	if (!SERVICE_ID_PATTERN.test(serviceId)) {
		return Response.json({ message: "Invalid service id" }, { status: 400 });
	}

	const service = await getService(serviceId);
	if (!service) {
		return Response.json({ message: "Service not found" }, { status: 404 });
	}

	if (!isMetricsEnabled()) {
		warnMissingMetricsConfig("service");
		return Response.json(createEmptyServiceMetrics(range));
	}

	try {
		return Response.json(await queryServiceMetrics({ serviceId, range }));
	} catch (error) {
		console.error("[metrics:service] failed to query service metrics:", error);
		return Response.json(
			{ message: "Service metrics unavailable" },
			{ status: 502 },
		);
	}
}
