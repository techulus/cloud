import { notFound } from "next/navigation";
import { PageHeader } from "@/components/core/page-header";
import { ServiceLayoutClient } from "@/components/service-layout-client";
import { getProjectBySlug, getService } from "@/db/queries";

export default async function ServiceLayout({
	params,
	children,
}: {
	params: Promise<{ slug: string; serviceId: string }>;
	children: React.ReactNode;
}) {
	const { slug, serviceId } = await params;
	const project = await getProjectBySlug(slug);
	const service = await getService(serviceId);

	if (!project || !service) {
		notFound();
	}

	return (
		<div className="space-y-6">
			<PageHeader
				breadcrumbs={[
					{ label: "Projects", href: "/dashboard" },
					{ label: project.name, href: `/dashboard/projects/${slug}` },
				]}
				title={service.name}
			/>
			<ServiceLayoutClient
				projectSlug={slug}
				projectId={project.id}
				serviceId={serviceId}
			>
				{children}
			</ServiceLayoutClient>
		</div>
	);
}
