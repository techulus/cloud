export const dynamic = "force-dynamic";

import { and, asc, eq, gt, or } from "drizzle-orm";
import { db } from "@/db";
import { environments, projects } from "@/db/schema";
import { requireApiKeyRole } from "@/lib/api-auth";
import { apiError, badRequest, notFound } from "@/lib/public-api";
import { namedPage, nextNamedCursor } from "@/lib/public-api-pagination";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	const auth = await requireApiKeyRole(request, [
		"admin",
		"developer",
		"reader",
	]);
	if (!auth.ok) return auth.response;
	const { projectId } = await params;
	let page: ReturnType<typeof namedPage>;
	try {
		page = namedPage(new URL(request.url));
	} catch (error) {
		return badRequest((error as Error).message, "INVALID_PAGINATION");
	}
	try {
		const project = await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1)
			.then((rows) => rows[0]);
		if (!project) return notFound();
		const items = await db
			.select({
				id: environments.id,
				name: environments.name,
				createdAt: environments.createdAt,
			})
			.from(environments)
			.where(
				and(
					eq(environments.projectId, projectId),
					page.cursor
						? or(
								gt(environments.name, page.cursor.name),
								and(
									eq(environments.name, page.cursor.name),
									gt(environments.id, page.cursor.id),
								),
							)
						: undefined,
				),
			)
			.orderBy(asc(environments.name), asc(environments.id))
			.limit(page.limit + 1);
		return Response.json({
			environments: items.slice(0, page.limit),
			nextCursor: nextNamedCursor(items, page.limit),
		});
	} catch (error) {
		console.error("[public-api] list environments failed", error);
		return apiError("Internal server error", "INTERNAL_ERROR", 500);
	}
}
