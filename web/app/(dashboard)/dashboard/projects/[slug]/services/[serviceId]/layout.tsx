import { notFound } from "next/navigation";
import { SetBreadcrumbData } from "@/components/core/breadcrumb-data";
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
		<>
			<SetBreadcrumbData
				data={{
					project: project.name,
					service: service.name,
				}}
			/>
			<ServiceLayoutClient
				projectSlug={slug}
				projectId={project.id}
				serviceId={serviceId}
			>
				{children}
			</ServiceLayoutClient>
		</>
	);
}
