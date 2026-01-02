import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { builds, projects, services, githubRepos } from "@/db/schema";
import { BuildDetails } from "@/components/build-details";

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

	let githubRepo = null;
	if (build.githubRepoId) {
		githubRepo = await db
			.select()
			.from(githubRepos)
			.where(eq(githubRepos.id, build.githubRepoId))
			.then((r) => r[0]);
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
	params: Promise<{ slug: string; serviceId: string; buildId: string }>;
}) {
	const { slug, serviceId, buildId } = await params;
	const data = await getBuild(slug, serviceId, buildId);

	if (!data) {
		notFound();
	}

	return (
		<BuildDetails
			projectSlug={slug}
			project={data.project}
			service={data.service}
			build={data.build}
			githubRepo={data.githubRepo}
		/>
	);
}
