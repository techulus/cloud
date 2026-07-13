export const dynamic = "force-dynamic";

import { desc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rollouts, serviceRevisions } from "@/db/schema";

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id: serviceId } = await params;

	const rolloutsList = await db
		.select({
			id: rollouts.id,
			serviceId: rollouts.serviceId,
			serviceRevisionId: rollouts.serviceRevisionId,
			status: rollouts.status,
			currentStage: rollouts.currentStage,
			createdAt: rollouts.createdAt,
			completedAt: rollouts.completedAt,
			revisionNumber: serviceRevisions.revisionNumber,
			contentHash: serviceRevisions.contentHash,
		})
		.from(rollouts)
		.innerJoin(
			serviceRevisions,
			eq(rollouts.serviceRevisionId, serviceRevisions.id),
		)
		.where(eq(rollouts.serviceId, serviceId))
		.orderBy(desc(rollouts.createdAt))
		.limit(50);

	return NextResponse.json({ rollouts: rolloutsList });
}
