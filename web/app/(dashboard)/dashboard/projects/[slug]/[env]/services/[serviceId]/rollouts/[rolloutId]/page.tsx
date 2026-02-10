import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { RolloutDetails } from "@/components/service/details/rollout-details";
import { db } from "@/db";
import { projects, rollouts, services } from "@/db/schema";

async function getRollout(
	projectSlug: string,
	serviceId: string,
	rolloutId: string,
) {
	const project = await db
		.select()
		.from(projects)
		.where(eq(projects.slug, projectSlug))
		.then((r) => r[0]);

	if (!project) return null;

	const service = await db
		.select()
		.from(services)
		.where(and(eq(services.id, serviceId), eq(services.projectId, project.id)))
		.then((r) => r[0]);

	if (!service) return null;

	const rollout = await db
		.select()
		.from(rollouts)
		.where(and(eq(rollouts.id, rolloutId), eq(rollouts.serviceId, serviceId)))
		.then((r) => r[0]);

	if (!rollout) return null;

	return { project, service, rollout };
}

export default async function RolloutPage({
	params,
}: {
	params: Promise<{
		slug: string;
		env: string;
		serviceId: string;
		rolloutId: string;
	}>;
}) {
	const { slug, env, serviceId, rolloutId } = await params;
	const data = await getRollout(slug, serviceId, rolloutId);

	if (!data) {
		notFound();
	}

	return (
		<>
			<SetBreadcrumbs
				items={[
					{ label: "Dashboard", href: "/dashboard" },
					{
						label: data.project.name,
						href: `/dashboard/projects/${slug}/${env}`,
					},
					{
						label: data.service.name,
						href: `/dashboard/projects/${slug}/${env}/services/${serviceId}`,
					},
					{
						label: "Rollout",
						href: `/dashboard/projects/${slug}/${env}/services/${serviceId}/rollouts/${rolloutId}`,
					},
				]}
			/>
			<RolloutDetails
				projectSlug={slug}
				envName={env}
				service={data.service}
				rollout={data.rollout}
			/>
		</>
	);
}
