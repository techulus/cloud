import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { builds } from "@/db/schema";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id: serviceId } = await params;

	const buildsList = await db
		.select()
		.from(builds)
		.where(eq(builds.serviceId, serviceId))
		.orderBy(desc(builds.createdAt))
		.limit(50);

	return NextResponse.json({ builds: buildsList });
}
