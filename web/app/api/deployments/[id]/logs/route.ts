import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { db } from "@/db";
import { containerLogs } from "@/db/schema";
import { eq, desc, gt, and } from "drizzle-orm";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return new Response("Unauthorized", { status: 401 });
	}

	const { id: deploymentId } = await params;
	const url = new URL(request.url);
	const limit = Math.min(
		Number.parseInt(url.searchParams.get("limit") || "100", 10),
		1000,
	);
	const after = url.searchParams.get("after");

	const logs = await db
		.select({
			id: containerLogs.id,
			deploymentId: containerLogs.deploymentId,
			stream: containerLogs.stream,
			message: containerLogs.message,
			timestamp: containerLogs.timestamp,
		})
		.from(containerLogs)
		.where(
			after
				? and(
						eq(containerLogs.deploymentId, deploymentId),
						gt(containerLogs.timestamp, new Date(after)),
					)
				: eq(containerLogs.deploymentId, deploymentId),
		)
		.orderBy(desc(containerLogs.timestamp))
		.limit(limit + 1);

	const hasMore = logs.length > limit;
	if (hasMore) logs.pop();

	return Response.json({
		logs: logs.reverse(),
		hasMore,
	});
}
