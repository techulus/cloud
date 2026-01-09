import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { builds } from "@/db/schema";

export async function GET(
	_: NextRequest,
	{ params }: { params: Promise<{ buildId: string }> },
) {
	const { buildId } = await params;

	const [build] = await db.select().from(builds).where(eq(builds.id, buildId));

	if (!build) {
		return NextResponse.json({ error: "Build not found" }, { status: 404 });
	}

	return NextResponse.json({ build });
}
