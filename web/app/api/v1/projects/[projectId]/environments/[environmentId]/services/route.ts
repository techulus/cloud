export const dynamic = "force-dynamic";

import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { environments, services } from "@/db/schema";
import { requireApiKeyRole } from "@/lib/api-auth";
import {
	apiError,
	badRequest,
	notFound,
	resolvePersistedSource,
} from "@/lib/public-api";
import { namedPage, nextNamedCursor } from "@/lib/public-api-pagination";

export async function GET(
	request: Request,
	{
		params,
	}: {
		params: Promise<{ projectId: string; environmentId: string }>;
	},
) {
	const auth = await requireApiKeyRole(request, [
		"admin",
		"developer",
		"reader",
	]);
	if (!auth.ok) return auth.response;
	const { projectId, environmentId } = await params;
	let page: ReturnType<typeof namedPage>;
	try {
		page = namedPage(new URL(request.url));
	} catch (error) {
		return badRequest((error as Error).message, "INVALID_PAGINATION");
	}
	try {
		const environment = await db
			.select({ id: environments.id })
			.from(environments)
			.where(
				and(
					eq(environments.id, environmentId),
					eq(environments.projectId, projectId),
				),
			)
			.limit(1)
			.then((rows) => rows[0]);
		if (!environment) return notFound();
		const rows = await db
			.select()
			.from(services)
			.where(
				and(
					eq(services.projectId, projectId),
					eq(services.environmentId, environmentId),
					isNull(services.deletedAt),
					page.cursor
						? or(
								gt(services.name, page.cursor.name),
								and(
									eq(services.name, page.cursor.name),
									gt(services.id, page.cursor.id),
								),
							)
						: undefined,
				),
			)
			.orderBy(asc(services.name), asc(services.id))
			.limit(page.limit + 1);
		const pageRows = rows.slice(0, page.limit);
		return Response.json({
			services: await Promise.all(
				pageRows.map(async (service) => ({
					id: service.id,
					name: service.name,
					hostname: service.hostname,
					source: await resolvePersistedSource(service),
					createdAt: service.createdAt,
				})),
			),
			nextCursor: nextNamedCursor(rows, page.limit),
		});
	} catch (error) {
		console.error("[public-api] list services failed", error);
		return apiError("Internal server error", "INTERNAL_ERROR", 500);
	}
}
