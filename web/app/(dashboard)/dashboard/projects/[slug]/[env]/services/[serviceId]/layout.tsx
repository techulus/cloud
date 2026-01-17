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
	const [project, service, proxyDomain] = await Promise.all([
		getProjectBySlug(slug),
		getService(serviceId),
		getSetting<string>(SETTING_KEYS.PROXY_DOMAIN),
	]);

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
				proxyDomain={proxyDomain}
			>
				{children}
			</ServiceLayoutClient>
		</>
	);
}
