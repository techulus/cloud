import { NextRequest, NextResponse } from "next/server";
import { isLoggingEnabled, queryLogsByRollout } from "@/lib/victoria-logs";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ rolloutId: string }> },
) {
	const { rolloutId } = await params;

	if (!isLoggingEnabled()) {
		return NextResponse.json({ logs: [] });
	}

	try {
		const { logs: rawLogs } = await queryLogsByRollout(rolloutId);

		const logs = rawLogs.map((log) => ({
			timestamp: log._time,
			message: log._msg,
			stage: log.stage,
		}));

		return NextResponse.json({ logs });
	} catch (error) {
		console.error("Failed to fetch rollout logs:", error);
		return NextResponse.json({ logs: [] });
	}
}
