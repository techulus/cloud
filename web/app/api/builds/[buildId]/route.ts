import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { builds } from "@/db/schema";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ buildId: string }> },
) {
	const { buildId } = await params;

	const [build] = await db.select().from(builds).where(eq(builds.id, buildId));

	if (!build) {
		return NextResponse.json({ error: "Build not found" }, { status: 404 });
	}

	return NextResponse.json({ build });
}
