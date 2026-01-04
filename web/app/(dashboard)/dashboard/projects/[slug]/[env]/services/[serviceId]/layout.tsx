import { notFound } from "next/navigation";
import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { ServiceLayoutClient } from "@/components/service-layout-client";
import { getProjectBySlug, getService } from "@/db/queries";

export default async function ServiceLayout({
	params,
	children,
}: {
	params: Promise<{ slug: string; env: string; serviceId: string }>;
	children: React.ReactNode;
}) {
	const { slug, env, serviceId } = await params;
	const project = await getProjectBySlug(slug);
	const service = await getService(serviceId);

	if (!project || !service) {
		notFound();
	}

	return (
		<>
			<SetBreadcrumbs
				items={[
					{ label: "Dashboard", href: "/dashboard" },
					{ label: project.name, href: `/dashboard/projects/${slug}/${env}` },
					{
						label: service.name,
						href: `/dashboard/projects/${slug}/${env}/services/${serviceId}`,
					},
				]}
			/>
			<ServiceLayoutClient
				projectSlug={slug}
				projectId={project.id}
				serviceId={serviceId}
				envName={env}
			>
				{children}
			</ServiceLayoutClient>
		</>
	);
}
