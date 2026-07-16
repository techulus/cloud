import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { subtractMilliseconds } from "@/lib/date";
import {
	emptyHistory,
	isMetricsEnabled,
	METRIC_RANGE_OPTIONS,
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

	if (!isMetricsEnabled()) {
		warnMissingMetricsConfig("server");
		return Response.json({
			current: null,
			history: emptyHistory(),
			range,
			enabled: false,
		});
	}

	const end = new Date();
	const option = METRIC_RANGE_OPTIONS[range];
	const start = subtractMilliseconds(end, option.durationMs);

	try {
		const [current, history] = await Promise.all([
			queryNodeMetricsSnapshot(serverId),
			queryNodeMetricsHistory({
				serverId,
				start,
				end,
				stepSeconds: option.stepSeconds,
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
