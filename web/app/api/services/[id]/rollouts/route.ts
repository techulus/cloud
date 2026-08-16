import { desc, eq, inArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { getService } from "@/db/queries";
import { builds, rollouts } from "@/db/schema";

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id: serviceId } = await params;
	if (!(await getService(serviceId))) {
		return NextResponse.json({ error: "Service not found" }, { status: 404 });
	}

	const rolloutsList = await db
		.select()
		.from(rollouts)
		.where(eq(rollouts.serviceId, serviceId))
		.orderBy(desc(rollouts.createdAt))
		.limit(50);

	const buildRows = rolloutsList.length
		? await db
				.select({
					serviceRevisionId: builds.serviceRevisionId,
					commitSha: builds.commitSha,
					commitMessage: builds.commitMessage,
				})
				.from(builds)
				.where(
					inArray(
						builds.serviceRevisionId,
						rolloutsList.map((rollout) => rollout.serviceRevisionId),
					),
				)
		: [];
	const buildsByRevision = new Map(
		buildRows.map((build) => [build.serviceRevisionId, build]),
	);

	return NextResponse.json({
		rollouts: rolloutsList.map((rollout) => {
			const build = buildsByRevision.get(rollout.serviceRevisionId);
			return {
				...rollout,
				commitSha: build?.commitSha ?? null,
				commitMessage: build?.commitMessage ?? null,
			};
		}),
	});
}
