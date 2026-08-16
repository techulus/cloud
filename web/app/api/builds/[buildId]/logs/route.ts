import { and, eq, isNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { builds, services } from "@/db/schema";
import { requireRequestSession } from "@/lib/api-auth";
import { invalidLogQueryResponse, normalizeLogSearch } from "@/lib/log-query";
import { isLoggingEnabled, queryLogsByBuild } from "@/lib/victoria-logs";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ buildId: string }> },
) {
	const sessionResult = await requireRequestSession(request);
	if (!sessionResult.ok) return sessionResult.response;

	const { buildId } = await params;
	const build = await db
		.select({ id: builds.id })
		.from(builds)
		.innerJoin(
			services,
			and(
				eq(builds.serviceId, services.id),
				isNull(services.deletedAt),
				isNull(services.previewOfServiceId),
			),
		)
		.where(eq(builds.id, buildId))
		.then((rows) => rows[0]);
	if (!build) {
		return NextResponse.json({ error: "Build not found" }, { status: 404 });
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
		const { logs: rawLogs } = await queryLogsByBuild(buildId, { search });

		const logs = rawLogs.map((log) => ({
			timestamp: log._time,
			message: log._msg,
		}));

		return NextResponse.json({ logs });
	} catch (error) {
		console.error("Failed to fetch build logs:", error);
		return NextResponse.json(
			{ message: "Failed to query build logs" },
			{ status: 502 },
		);
	}
}
