import { desc, eq, getTableColumns } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { builds, servers } from "@/db/schema";
import { requireRequestSession } from "@/lib/api-auth";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const sessionResult = await requireRequestSession(request);
	if (!sessionResult.ok) return sessionResult.response;

	const { id: serviceId } = await params;

	const buildsList = await db
		.select({
			...getTableColumns(builds),
			server: { id: servers.id, name: servers.name },
		})
		.from(builds)
		.leftJoin(servers, eq(builds.claimedBy, servers.id))
		.where(eq(builds.serviceId, serviceId))
		.orderBy(desc(builds.createdAt))
		.limit(50);

	return NextResponse.json({ builds: buildsList });
}
