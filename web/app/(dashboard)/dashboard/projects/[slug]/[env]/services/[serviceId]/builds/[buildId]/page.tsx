import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { BuildDetails } from "@/components/builds/build-details";
import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { db } from "@/db";
import { builds, projects, serviceRevisions, services } from "@/db/schema";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";

async function getBuild(
	projectSlug: string,
	serviceId: string,
	buildId: string,
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

	const build = await db
		.select()
		.from(builds)
		.where(and(eq(builds.id, buildId), eq(builds.serviceId, serviceId)))
		.then((r) => r[0]);

	if (!build) return null;

	const revision = await db
		.select({ specification: serviceRevisions.specification })
		.from(serviceRevisions)
		.where(
			and(
				eq(serviceRevisions.id, build.serviceRevisionId),
				eq(serviceRevisions.serviceId, build.serviceId),
			),
		)
		.then((rows) => rows[0]);
	let githubRepo: { repoFullName: string } | null = null;
	try {
		const source = revision
			? parseServiceRevisionSpec(revision.specification).source
			: null;
		if (source?.type === "github") {
			githubRepo = {
				repoFullName: new URL(source.repository).pathname.replace(/^\//, ""),
			};
		}
	} catch {
		// Keep historical builds visible when their revision cannot be parsed.
	}

	return {
		project,
		service,
		build,
		githubRepo,
	};
}

export default async function BuildPage({
	params,
}: {
	params: Promise<{
		slug: string;
		env: string;
		serviceId: string;
		buildId: string;
	}>;
}) {
	const { slug, env, serviceId, buildId } = await params;
	const data = await getBuild(slug, serviceId, buildId);

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
						label: `${data.service.name} (${env})`,
						href: `/dashboard/projects/${slug}/${env}/services/${serviceId}`,
					},
					{
						label: `Build ${data.build.commitSha.slice(0, 7)}`,
						href: `/dashboard/projects/${slug}/${env}/services/${serviceId}/builds/${buildId}`,
					},
				]}
			/>
			<BuildDetails
				projectSlug={slug}
				envName={env}
				service={data.service}
				build={data.build}
				githubRepo={data.githubRepo}
			/>
		</>
	);
}
