import { notFound } from "next/navigation";
import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { ServiceLayoutClient } from "@/components/service/service-layout-client";
import { getProjectBySlug, getService, getSetting } from "@/db/queries";
import { SETTING_KEYS } from "@/lib/settings-keys";

export default async function ServiceLayout({
	params,
	children,
}: {
	params: Promise<{ slug: string; env: string; serviceId: string }>;
	children: React.ReactNode;
}) {
	const { slug, env, serviceId } = await params;
	const [project, service, edgeDomain, autoSubdomainDomain] = await Promise.all(
		[
			getProjectBySlug(slug),
			getService(serviceId),
			getSetting<string>(SETTING_KEYS.EDGE_DOMAIN),
			getSetting<string>(SETTING_KEYS.AUTO_SUBDOMAIN_DOMAIN),
		],
	);

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
						label: `${service.name} (${env})`,
						href: `/dashboard/projects/${slug}/${env}/services/${serviceId}`,
					},
				]}
			/>
			<ServiceLayoutClient
				projectSlug={slug}
				projectId={project.id}
				serviceId={serviceId}
				envName={env}
				edgeDomain={edgeDomain}
				autoSubdomainDomain={autoSubdomainDomain}
			>
				{children}
			</ServiceLayoutClient>
		</>
	);
}
