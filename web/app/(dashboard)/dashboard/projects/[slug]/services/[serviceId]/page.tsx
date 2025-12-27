import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { ServiceDetails } from "@/components/service-details";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	projects,
	servers,
	servicePorts,
	serviceReplicas,
	services,
} from "@/db/schema";

async function getService(projectSlug: string, serviceId: string) {
	const project = await db
		.select()
		.from(projects)
		.where(eq(projects.slug, projectSlug))
		.then((r) => r[0]);

	if (!project) return null;

	const service = await db
		.select()
		.from(services)
		.where(and(eq(services.id, serviceId), eq(services.projectId, project.id)))
		.then((r) => r[0]);

	if (!service) return null;

	const [ports, serviceDeployments, configuredReplicas] = await Promise.all([
		db
			.select()
			.from(servicePorts)
			.where(eq(servicePorts.serviceId, service.id))
			.orderBy(servicePorts.port),
		db
			.select()
			.from(deployments)
			.where(eq(deployments.serviceId, service.id))
			.orderBy(deployments.createdAt),
		db
			.select({
				id: serviceReplicas.id,
				serverId: serviceReplicas.serverId,
				serverName: servers.name,
				count: serviceReplicas.count,
			})
			.from(serviceReplicas)
			.innerJoin(servers, eq(serviceReplicas.serverId, servers.id))
			.where(eq(serviceReplicas.serviceId, service.id)),
	]);

	const deploymentsWithDetails = await Promise.all(
		serviceDeployments.map(async (deployment) => {
			const [depPorts, server] = await Promise.all([
				db
					.select({
						id: deploymentPorts.id,
						hostPort: deploymentPorts.hostPort,
						containerPort: servicePorts.port,
					})
					.from(deploymentPorts)
					.innerJoin(
						servicePorts,
						eq(deploymentPorts.servicePortId, servicePorts.id),
					)
					.where(eq(deploymentPorts.deploymentId, deployment.id)),
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
		project,
		service: {
			...service,
			ports,
			configuredReplicas,
			deployments: deploymentsWithDetails,
		},
	};
}

export default async function ServicePage({
	params,
}: {
	params: Promise<{ slug: string; serviceId: string }>;
}) {
	const { slug, serviceId } = await params;
	const data = await getService(slug, serviceId);

	if (!data) {
		notFound();
	}

	return (
		<div className="space-y-6">
			<PageHeader
				title={data.service.name}
				breadcrumbs={[
					{ label: "Projects", href: "/dashboard" },
					{ label: data.project.name, href: `/dashboard/projects/${slug}` },
				]}
			/>
			<ServiceDetails projectSlug={slug} service={data.service} />
		</div>
	);
}
