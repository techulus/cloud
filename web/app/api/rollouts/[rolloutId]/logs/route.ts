import { and, eq, isNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rollouts, services } from "@/db/schema";
import { requireRequestSession } from "@/lib/api-auth";
import { invalidLogQueryResponse, normalizeLogSearch } from "@/lib/log-query";
import { isLoggingEnabled, queryLogsByRollout } from "@/lib/victoria-logs";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ rolloutId: string }> },
) {
	const sessionResult = await requireRequestSession(request);
	if (!sessionResult.ok) return sessionResult.response;

	const { rolloutId } = await params;
	const rollout = await db
		.select({ id: rollouts.id })
		.from(rollouts)
		.innerJoin(
			services,
			and(
				eq(rollouts.serviceId, services.id),
				isNull(services.deletedAt),
				isNull(services.previewOfServiceId),
			),
		)
		.where(eq(rollouts.id, rolloutId))
		.then((rows) => rows[0]);
	if (!rollout) {
		return NextResponse.json({ error: "Rollout not found" }, { status: 404 });
	}

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
