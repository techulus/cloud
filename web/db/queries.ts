import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	projects,
	secrets,
	servers,
	servicePorts,
	serviceReplicas,
	services,
} from "@/db/schema";

export async function listProjects() {
	const projectList = await db
		.select()
		.from(projects)
		.orderBy(projects.createdAt);

	const projectsWithCounts = await Promise.all(
		projectList.map(async (project) => {
			const serviceCount = await db
				.select({ count: services.id })
				.from(services)
				.where(eq(services.projectId, project.id));
			return {
				...project,
				serviceCount: serviceCount.length,
			};
		}),
	);

	return projectsWithCounts;
}

export async function getProject(id: string) {
	const results = await db.select().from(projects).where(eq(projects.id, id));
	return results[0] || null;
}

export async function getProjectBySlug(slug: string) {
	const results = await db
		.select()
		.from(projects)
		.where(eq(projects.slug, slug));
	return results[0] || null;
}

export async function listServices(projectId: string) {
	return db
		.select()
		.from(services)
		.where(eq(services.projectId, projectId))
		.orderBy(services.createdAt);
}

export async function getService(id: string) {
	const results = await db.select().from(services).where(eq(services.id, id));
	return results[0] || null;
}

export async function getOnlineServers() {
	return db
		.select({
			id: servers.id,
			name: servers.name,
			wireguardIp: servers.wireguardIp,
		})
		.from(servers)
		.where(eq(servers.status, "online"));
}

export async function getServicePorts(serviceId: string) {
	return db
		.select()
		.from(servicePorts)
		.where(eq(servicePorts.serviceId, serviceId))
		.orderBy(servicePorts.port);
}

export async function getDeploymentPorts(deploymentId: string) {
	return db
		.select({
			id: deploymentPorts.id,
			hostPort: deploymentPorts.hostPort,
			containerPort: servicePorts.port,
		})
		.from(deploymentPorts)
		.innerJoin(servicePorts, eq(deploymentPorts.servicePortId, servicePorts.id))
		.where(eq(deploymentPorts.deploymentId, deploymentId));
}

export async function listDeployments(serviceId: string) {
	return db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId))
		.orderBy(deployments.createdAt);
}

export async function getServiceReplicas(serviceId: string) {
	const replicas = await db
		.select({
			id: serviceReplicas.id,
			serverId: serviceReplicas.serverId,
			serverName: servers.name,
			count: serviceReplicas.count,
		})
		.from(serviceReplicas)
		.innerJoin(servers, eq(serviceReplicas.serverId, servers.id))
		.where(eq(serviceReplicas.serviceId, serviceId));

	return replicas;
}

export async function listSecrets(serviceId: string) {
	const secretsList = await db
		.select({
			id: secrets.id,
			key: secrets.key,
			createdAt: secrets.createdAt,
		})
		.from(secrets)
		.where(eq(secrets.serviceId, serviceId))
		.orderBy(secrets.createdAt);

	return secretsList;
}

export async function listServers() {
	return db.select().from(servers).orderBy(servers.createdAt);
}

export async function getServer(id: string) {
	const results = await db.select().from(servers).where(eq(servers.id, id));
	return results[0] || null;
}

export async function getServerDetails(id: string) {
	const serverResults = await db
		.select({
			id: servers.id,
			name: servers.name,
			publicIp: servers.publicIp,
			wireguardIp: servers.wireguardIp,
			status: servers.status,
			lastHeartbeat: servers.lastHeartbeat,
			resourcesCpu: servers.resourcesCpu,
			resourcesMemory: servers.resourcesMemory,
			resourcesDisk: servers.resourcesDisk,
			createdAt: servers.createdAt,
			agentToken: servers.agentToken,
		})
		.from(servers)
		.where(eq(servers.id, id));

	return serverResults[0] || null;
}
