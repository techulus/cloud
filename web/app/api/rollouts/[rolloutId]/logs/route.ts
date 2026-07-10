import { type NextRequest, NextResponse } from "next/server";
import { invalidLogQueryResponse, normalizeLogSearch } from "@/lib/log-query";
import { isLoggingEnabled, queryLogsByRollout } from "@/lib/victoria-logs";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ rolloutId: string }> },
) {
	const { rolloutId } = await params;
	let search: string | undefined;
	try {
		search = normalizeLogSearch(request.nextUrl.searchParams.get("q"));
	} catch (error) {
		return invalidLogQueryResponse(error);
	}

	if (!isLoggingEnabled()) {
		return NextResponse.json({ logs: [] });
	}

	try {
		const { logs: rawLogs } = await queryLogsByRollout(rolloutId, { search });

		const logs = rawLogs.map((log) => ({
			timestamp: log._time,
			message: log._msg,
			stage: log.stage,
		}));

		return NextResponse.json({ logs });
	} catch (error) {
		console.error("Failed to fetch rollout logs:", error);
		return NextResponse.json(
			{ message: "Failed to query rollout logs" },
			{ status: 502 },
		);
	}
}
