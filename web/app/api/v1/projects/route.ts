export const dynamic = "force-dynamic";

import { and, asc, eq, gt, or } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { requireApiKeyRole } from "@/lib/api-auth";
import { apiError, badRequest } from "@/lib/public-api";
import { namedPage, nextNamedCursor } from "@/lib/public-api-pagination";

export async function GET(request: Request) {
	const auth = await requireApiKeyRole(request, [
		"admin",
		"developer",
		"reader",
	]);
	if (!auth.ok) return auth.response;
	let page: ReturnType<typeof namedPage>;
	try {
		page = namedPage(new URL(request.url));
	} catch (error) {
		return badRequest((error as Error).message, "INVALID_PAGINATION");
	}
	try {
		const rows = await db
			.select({
				id: projects.id,
				name: projects.name,
				slug: projects.slug,
				createdAt: projects.createdAt,
			})
			.from(projects)
			.where(
				page.cursor
					? or(
							gt(projects.name, page.cursor.name),
							and(
								eq(projects.name, page.cursor.name),
								gt(projects.id, page.cursor.id),
							),
						)
					: undefined,
			)
			.orderBy(asc(projects.name), asc(projects.id))
			.limit(page.limit + 1);
		return Response.json({
			projects: rows.slice(0, page.limit),
			nextCursor: nextNamedCursor(rows, page.limit),
		});
	} catch (error) {
		console.error("[public-api] list projects failed", error);
		return apiError("Internal server error", "INTERNAL_ERROR", 500);
	}
}
