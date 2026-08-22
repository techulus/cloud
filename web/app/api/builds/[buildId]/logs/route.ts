import { type NextRequest, NextResponse } from "next/server";
import { invalidLogQueryResponse, normalizeLogSearch } from "@/lib/log-query";
import { reportServerError } from "@/lib/server-errors";
import { isLoggingEnabled, queryLogsByBuild } from "@/lib/victoria-logs";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ buildId: string }> },
) {
	const { buildId } = await params;
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
		const { logs: rawLogs } = await queryLogsByBuild(buildId, { search });

		const logs = rawLogs.map((log) => ({
			timestamp: log._time,
			message: log._msg,
		}));

		return NextResponse.json({ logs });
	} catch (error) {
		reportServerError(error, "logs.build.query", { tags: { buildId } });
		console.error("Failed to fetch build logs:", error);
		return NextResponse.json(
			{ message: "Failed to query build logs" },
			{ status: 502 },
		);
	}
}
