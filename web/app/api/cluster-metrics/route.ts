import { headers } from "next/headers";
import { listServers } from "@/db/queries";
import { auth } from "@/lib/auth";
import {
	isMetricsEnabled,
	METRIC_RANGE_OPTIONS,
	parseMetricRange,
	queryServersMetricsHistory,
} from "@/lib/victoria-metrics";

export async function GET(request: Request) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return new Response("Unauthorized", { status: 401 });
	}

	const url = new URL(request.url);
	const range = parseMetricRange(url.searchParams.get("range"));
	const serverId = url.searchParams.get("serverId");

	if (!isMetricsEnabled()) {
		throw new Error(
			"Missing VictoriaMetrics configuration: set VICTORIA_METRICS_URL or VICTORIA_METRICS_PRIVATE_URL",
		);
	}

	const end = new Date();
	const option = METRIC_RANGE_OPTIONS[range];
	const start = new Date(end.getTime() - option.durationMs);
	const servers = await listServers();
	const selectedServers =
		serverId && serverId !== "all"
			? servers.filter((server) => server.id === serverId)
			: servers;

	try {
		const series = await queryServersMetricsHistory({
			servers: selectedServers.map((server) => ({
				id: server.id,
				name: server.name,
			})),
			start,
			end,
			stepSeconds: option.stepSeconds,
		});

		return Response.json({
			range,
			series,
		});
	} catch (error) {
		console.error("[metrics:cluster] failed to query metrics:", error);
		return Response.json({
			range,
			series: [],
		});
	}
}
