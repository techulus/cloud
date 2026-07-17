import { headers } from "next/headers";
import { getServerDetails } from "@/db/queries";
import { auth } from "@/lib/auth";
import {
	emptyHistory,
	getMetricWindow,
	isMetricsEnabled,
	parseMetricRange,
	queryNodeMetricsHistory,
	queryNodeMetricsSnapshot,
	warnMissingMetricsConfig,
} from "@/lib/victoria-metrics";

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

	const { id: serverId } = await params;
	const url = new URL(request.url);
	const range = parseMetricRange(url.searchParams.get("range"));
	const server = await getServerDetails(serverId);

	if (!server) {
		return Response.json({ message: "Server not found" }, { status: 404 });
	}

	if (!isMetricsEnabled()) {
		warnMissingMetricsConfig("server");
		return Response.json({
			current: null,
			history: emptyHistory(),
			range,
			enabled: false,
		});
	}

	const { start, end, stepSeconds } = getMetricWindow(range);

	try {
		const [current, history] = await Promise.all([
			queryNodeMetricsSnapshot(serverId),
			queryNodeMetricsHistory({
				serverId,
				start,
				end,
				stepSeconds,
			}),
		]);

		return Response.json({
			current,
			history,
			range,
		});
	} catch (error) {
		console.error("[metrics:server] failed to query metrics:", error);
		return Response.json({
			current: null,
			history: emptyHistory(),
			range,
			available: false,
		});
	}
}
