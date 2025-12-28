import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { db } from "@/db";
import { containerLogs, deployments } from "@/db/schema";
import { eq, desc, inArray, gt, and } from "drizzle-orm";

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

	const { id: serviceId } = await params;
	const url = new URL(request.url);
	const limit = Math.min(
		Number.parseInt(url.searchParams.get("limit") || "100", 10),
		1000,
	);
	const after = url.searchParams.get("after");

	const serviceDeployments = await db
		.select({ id: deployments.id })
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	if (serviceDeployments.length === 0) {
		return Response.json({ logs: [], hasMore: false });
	}

	const deploymentIds = serviceDeployments.map((d) => d.id);

	const whereCondition = after
		? and(
				inArray(containerLogs.deploymentId, deploymentIds),
				gt(containerLogs.timestamp, new Date(after)),
			)
		: inArray(containerLogs.deploymentId, deploymentIds);

	let query = db
		.select({
			id: containerLogs.id,
			deploymentId: containerLogs.deploymentId,
			stream: containerLogs.stream,
			message: containerLogs.message,
			timestamp: containerLogs.timestamp,
		})
		.from(containerLogs)
		.where(whereCondition)
		.orderBy(desc(containerLogs.timestamp))
		.limit(limit + 1);

	const logs = await query;
	const hasMore = logs.length > limit;
	if (hasMore) logs.pop();

	return Response.json({
		logs: logs.reverse(),
		hasMore,
	});
}
