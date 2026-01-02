import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { ServiceHeader } from "@/components/service-header";
import { ServiceLayoutClient } from "@/components/service-layout-client";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	projects,
	rollouts,
	servers,
	servicePorts,
	serviceReplicas,
	services,
	serviceVolumes,
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

	const [ports, serviceDeployments, configuredReplicas, volumes, lockedServer, serviceRollouts] = await Promise.all([
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
		db
			.select()
			.from(serviceVolumes)
			.where(eq(serviceVolumes.serviceId, service.id)),
		service.lockedServerId
			? db
					.select({ name: servers.name })
					.from(servers)
					.where(eq(servers.id, service.lockedServerId))
					.then((r) => r[0])
			: Promise.resolve(null),
		db
			.select()
			.from(rollouts)
			.where(eq(rollouts.serviceId, service.id))
			.orderBy(rollouts.createdAt),
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
			volumes,
			lockedServer,
			rollouts: serviceRollouts,
		},
	};
}

export default async function ServiceLayout({
	params,
	children,
}: {
	params: Promise<{ slug: string; serviceId: string }>;
	children: React.ReactNode;
}) {
	const { slug, serviceId } = await params;
	const data = await getService(slug, serviceId);

	if (!data) {
		notFound();
	}

	return (
		<div className="space-y-6">
			<ServiceHeader
				serviceId={data.service.id}
				serviceName={data.service.name}
				breadcrumbs={[
					{ label: "Projects", href: "/dashboard" },
					{ label: data.project.name, href: `/dashboard/projects/${slug}` },
				]}
			/>
			<ServiceLayoutClient
				projectSlug={slug}
				initialService={data.service}
			>
				{children}
			</ServiceLayoutClient>
		</div>
	);
}
