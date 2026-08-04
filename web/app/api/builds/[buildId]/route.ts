import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { builds, servers } from "@/db/schema";

export async function GET(
	_: NextRequest,
	{ params }: { params: Promise<{ buildId: string }> },
) {
	const { buildId } = await params;

	const [buildData] = await db
		.select({
			build: builds,
			server: { id: servers.id, name: servers.name },
		})
		.from(builds)
		.leftJoin(servers, eq(builds.claimedBy, servers.id))
		.where(eq(builds.id, buildId));

	if (!buildData) {
		return NextResponse.json({ error: "Build not found" }, { status: 404 });
	}

	return NextResponse.json(buildData);
}
