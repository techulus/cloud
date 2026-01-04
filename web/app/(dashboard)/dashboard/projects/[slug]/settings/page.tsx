import { notFound } from "next/navigation";
import { SetBreadcrumbData } from "@/components/core/breadcrumb-data";
import { EnvironmentManagement } from "@/components/environment-management";
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
			<SetBreadcrumbData data={{ project: project.name }} />
			<div className="space-y-6">
				<div>
					<h1 className="text-2xl font-bold">Project Settings</h1>
					<p className="text-muted-foreground">
						Manage environments and project configuration
					</p>
				</div>

				<EnvironmentManagement
					projectId={project.id}
					initialEnvironments={environments}
				/>
			</div>
		</>
	);
}
