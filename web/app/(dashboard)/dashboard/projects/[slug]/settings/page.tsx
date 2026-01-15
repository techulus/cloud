import { notFound } from "next/navigation";
import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { EnvironmentManagement } from "@/components/project/environment-management";
import {
	ProjectSettingsPanel,
	ProjectDangerZone,
} from "@/components/project/project-settings-panel";
import { getProjectBySlug, listEnvironments } from "@/db/queries";

export default async function ProjectSettingsPage({
	params,
}: {
	params: Promise<{ slug: string }>;
}) {
	const { slug } = await params;
	const project = await getProjectBySlug(slug);

	if (!project) {
		notFound();
	}

	const environments = await listEnvironments(project.id);

	return (
		<>
			<SetBreadcrumbs
				items={[
					{ label: "Dashboard", href: "/dashboard" },
					{
						label: project.name,
						href: `/dashboard/projects/${slug}/production`,
					},
					{ label: "Settings", href: `/dashboard/projects/${slug}/settings` },
				]}
			/>
			<div className="container max-w-7xl mx-auto px-4 py-6 space-y-6">
				<ProjectSettingsPanel project={project} />

				<EnvironmentManagement
					projectId={project.id}
					initialEnvironments={environments}
				/>

				<ProjectDangerZone project={project} />
			</div>
		</>
	);
}
