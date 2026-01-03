import { notFound } from "next/navigation";
import { SetBreadcrumbData } from "@/components/core/breadcrumb-data";
import { ServiceCanvas } from "@/components/service-canvas";
import { getProjectBySlug } from "@/db/queries";

export default async function ProjectPage({
	params,
}: {
	params: Promise<{ slug: string }>;
}) {
	const { slug } = await params;
	const project = await getProjectBySlug(slug);

	if (!project) {
		notFound();
	}

	return (
		<>
			<SetBreadcrumbData data={{ project: project.name }} />
			<ServiceCanvas projectId={project.id} projectSlug={slug} />
		</>
	);
}
