import { NextRequest, NextResponse } from "next/server";
import { isLoggingEnabled, queryLogsByBuild } from "@/lib/victoria-logs";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ buildId: string }> }
) {
	const { buildId } = await params;

	if (!isLoggingEnabled()) {
		return NextResponse.json({ logs: [] });
	}

	try {
		const { logs: rawLogs } = await queryLogsByBuild(buildId);

		const logs = rawLogs.map((log) => ({
			timestamp: log._time,
			message: log._msg,
		}));

		return NextResponse.json({ logs });
	} catch (error) {
		console.error("Failed to fetch build logs:", error);
		return NextResponse.json({ logs: [] });
	}
}
