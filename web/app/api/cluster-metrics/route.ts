import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
	emptyHistory,
	isMetricsEnabled,
	METRIC_RANGE_OPTIONS,
	parseMetricRange,
	queryClusterMetricsHistory,
	queryClusterMetricsSnapshot,
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

	if (!isMetricsEnabled()) {
		return Response.json({
			current: null,
			history: emptyHistory(),
			range,
			enabled: false,
		});
	}

	const end = new Date();
	const option = METRIC_RANGE_OPTIONS[range];
	const start = new Date(end.getTime() - option.durationMs);

	try {
		const [current, history] = await Promise.all([
			queryClusterMetricsSnapshot(),
			queryClusterMetricsHistory({
				start,
				end,
				stepSeconds: option.stepSeconds,
			}),
		]);

		return Response.json({
			current,
			history,
			range,
			enabled: true,
		});
	} catch (error) {
		console.error("[metrics:cluster] failed to query metrics:", error);
		return Response.json({
			current: null,
			history: emptyHistory(),
			range,
			enabled: true,
		});
	}
}
