import { and, eq, isNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { builds, servers, services } from "@/db/schema";
import { requireRequestSession } from "@/lib/api-auth";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ buildId: string }> },
) {
	const sessionResult = await requireRequestSession(request);
	if (!sessionResult.ok) return sessionResult.response;

	const { buildId } = await params;

	const [buildData] = await db
		.select({
			build: builds,
			server: { id: servers.id, name: servers.name },
		})
		.from(builds)
		.leftJoin(servers, eq(builds.claimedBy, servers.id))
		.innerJoin(
			services,
			and(
				eq(builds.serviceId, services.id),
				isNull(services.deletedAt),
				isNull(services.previewOfServiceId),
			),
		)
		.where(eq(builds.id, buildId));

	if (!buildData) {
		return NextResponse.json({ error: "Build not found" }, { status: 404 });
	}

	return NextResponse.json(buildData);
}
