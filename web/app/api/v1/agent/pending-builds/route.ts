import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { builds } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";

export async function GET(request: NextRequest) {
	const auth = await verifyAgentRequest(request);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	const pendingBuild = await db
		.select({
			id: builds.id,
			commitSha: builds.commitSha,
			commitMessage: builds.commitMessage,
			branch: builds.branch,
			serviceId: builds.serviceId,
			githubRepoId: builds.githubRepoId,
		})
		.from(builds)
		.where(eq(builds.status, "pending"))
		.orderBy(asc(builds.createdAt))
		.limit(1)
		.then((r) => r[0]);

	return NextResponse.json({ build: pendingBuild || null });
}
