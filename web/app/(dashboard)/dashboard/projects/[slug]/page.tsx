import { notFound } from "next/navigation";
import { PageHeader } from "@/components/core/page-header";
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
		<div className="relative">
			<PageHeader
				breadcrumbs={[{ label: "Projects", href: "/dashboard" }]}
				title={project.name}
			/>
			<ServiceCanvas projectId={project.id} projectSlug={slug} />
		</div>
	);
}
