import { notFound } from "next/navigation";
import {
	getProjectBySlug,
	listServices,
	listDeployments,
	getServicePorts,
	getDeploymentPorts,
	getServiceReplicas,
} from "@/actions/projects";
import { ServiceCanvas } from "@/components/service-canvas";
import { PageHeader } from "@/components/page-header";
import { CreateServiceDialog } from "@/components/create-service-dialog";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { eq } from "drizzle-orm";

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

	const servicesList = await listServices(project.id);

	const initialServices = await Promise.all(
		servicesList.map(async (service) => {
			const [ports, serviceDeployments, configuredReplicas] = await Promise.all(
				[
					getServicePorts(service.id),
					listDeployments(service.id),
					getServiceReplicas(service.id),
				],
			);

			const deploymentsWithDetails = await Promise.all(
				serviceDeployments.map(async (deployment) => {
					const [depPorts, server] = await Promise.all([
						getDeploymentPorts(deployment.id),
						db
							.select({ name: servers.name, wireguardIp: servers.wireguardIp })
							.from(servers)
							.where(eq(servers.id, deployment.serverId))
							.then((r) => r[0]),
					]);

					return {
						...deployment,
						ports: depPorts,
						server,
					};
				}),
			);

			return {
				...service,
				ports,
				configuredReplicas,
				deployments: deploymentsWithDetails,
			};
		}),
	);

	return (
		<div className="relative">
			<div className="absolute top-0 left-0 right-0 z-10 py-2 -mx-4 px-4">
				<PageHeader
					title={project.name}
					breadcrumbs={[{ label: "Projects", href: "/dashboard" }]}
					actions={<CreateServiceDialog projectId={project.id} />}
				/>
			</div>
			<ServiceCanvas
				projectId={project.id}
				projectSlug={slug}
				initialServices={initialServices}
			/>
		</div>
	);
}
