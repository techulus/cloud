import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
	emptyHistory,
	isMetricsEnabled,
	queryNodeMetricsHistory,
	queryNodeMetricsSnapshot,
} from "@/lib/victoria-metrics";

const RANGE_OPTIONS = {
	"1h": { durationMs: 60 * 60 * 1000, stepSeconds: 30 },
	"6h": { durationMs: 6 * 60 * 60 * 1000, stepSeconds: 60 },
	"24h": { durationMs: 24 * 60 * 60 * 1000, stepSeconds: 5 * 60 },
	"7d": { durationMs: 7 * 24 * 60 * 60 * 1000, stepSeconds: 30 * 60 },
} as const;

type RangeKey = keyof typeof RANGE_OPTIONS;

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
	const range = parseRange(url.searchParams.get("range"));

	if (!isMetricsEnabled()) {
		return Response.json({
			current: null,
			history: emptyHistory(),
			range,
			enabled: false,
		});
	}

	const end = new Date();
	const option = RANGE_OPTIONS[range];
	const start = new Date(end.getTime() - option.durationMs);

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
			enabled: true,
		});
	} catch (error) {
		console.error("[metrics:server] failed to query metrics:", error);
		return Response.json({
			current: null,
			history: emptyHistory(),
			range,
			enabled: true,
		});
	}
}

function parseRange(value: string | null): RangeKey {
	if (value && value in RANGE_OPTIONS) {
		return value as RangeKey;
	}
	return "1h";
}
