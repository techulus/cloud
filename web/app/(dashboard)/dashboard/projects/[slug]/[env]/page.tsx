import { notFound } from "next/navigation";
import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { ServiceCanvas } from "@/components/service-canvas";
import { getProjectBySlug, getEnvironmentByName } from "@/db/queries";

export default async function ProjectEnvironmentPage({
	params,
}: {
	params: Promise<{ slug: string; env: string }>;
}) {
	const { slug, env: envName } = await params;
	const project = await getProjectBySlug(slug);

	if (!project) {
		notFound();
	}

	const environment = await getEnvironmentByName(project.id, envName);

	if (!environment) {
		notFound();
	}

	return (
		<>
			<SetBreadcrumbs
				items={[
					{ label: "Dashboard", href: "/dashboard" },
					{
						label: project.name,
						href: `/dashboard/projects/${slug}/${envName}`,
					},
				]}
			/>
			<ServiceCanvas
				projectId={project.id}
				projectSlug={slug}
				envId={environment.id}
				envName={environment.name}
			/>
		</>
	);
}
