export const dynamic = "force-dynamic";

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { services } from "@/db/schema";
import { requireRequestSession } from "@/lib/api-auth";
import { decodeTimestampCursor } from "@/lib/public-api-pagination";
import { queryServiceRevisionChangelog } from "@/lib/service-revision-changelog";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const sessionResult = await requireRequestSession(request);
	if (!sessionResult.ok) return sessionResult.response;

	const { id: serviceId } = await params;
	const cursorValue = new URL(request.url).searchParams.get("cursor");
	const cursor = decodeTimestampCursor(cursorValue);
	if (cursorValue && !cursor) {
		return Response.json(
			{ message: "Invalid revision cursor" },
			{ status: 400 },
		);
	}

	const service = await db
		.select({ id: services.id })
		.from(services)
		.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
		.then((rows) => rows[0]);
	if (!service) {
		return Response.json({ message: "Service not found" }, { status: 404 });
	}

	return Response.json(
		await queryServiceRevisionChangelog(serviceId, cursor ?? undefined),
	);
}
