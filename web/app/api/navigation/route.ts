import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/db";
import { environments, projects, servers, services } from "@/db/schema";
import { auth } from "@/lib/auth";
import { buildNavigationItems } from "@/lib/navigation";

export async function GET() {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const [entityRows, serverRows] = await Promise.all([
		db
			.select({
				projectId: projects.id,
				projectName: projects.name,
				projectSlug: projects.slug,
				environmentId: environments.id,
				environmentName: environments.name,
				serviceId: services.id,
				serviceName: services.name,
				serviceHostname: services.hostname,
			})
			.from(projects)
			.leftJoin(environments, eq(environments.projectId, projects.id))
			.leftJoin(
				services,
				and(
					eq(services.projectId, projects.id),
					eq(services.environmentId, environments.id),
					isNull(services.deletedAt),
				),
			)
			.orderBy(projects.name, environments.name, services.name),
		db
			.select({ id: servers.id, name: servers.name })
			.from(servers)
			.orderBy(servers.name),
	]);

	return Response.json({ items: buildNavigationItems(entityRows, serverRows) });
}
