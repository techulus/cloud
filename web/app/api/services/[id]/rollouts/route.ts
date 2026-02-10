import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { rollouts } from "@/db/schema";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id: serviceId } = await params;

	const rolloutsList = await db
		.select()
		.from(rollouts)
		.where(eq(rollouts.serviceId, serviceId))
		.orderBy(desc(rollouts.createdAt))
		.limit(50);

	return NextResponse.json({ rollouts: rolloutsList });
}
