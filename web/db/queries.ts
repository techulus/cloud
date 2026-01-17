import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	environments,
	projects,
	secrets,
	servers,
	servicePorts,
	serviceReplicas,
	services,
	settings,
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
			privateIp: servers.privateIp,
			wireguardIp: servers.wireguardIp,
			isProxy: servers.isProxy,
			status: servers.status,
			lastHeartbeat: servers.lastHeartbeat,
			resourcesCpu: servers.resourcesCpu,
			resourcesMemory: servers.resourcesMemory,
			resourcesDisk: servers.resourcesDisk,
			meta: servers.meta,
			createdAt: servers.createdAt,
			agentToken: servers.agentToken,
		})
		.from(servers)
		.where(eq(servers.id, id));

	return serverResults[0] || null;
}

export async function listEnvironments(projectId: string) {
	return db
		.select()
		.from(environments)
		.where(eq(environments.projectId, projectId))
		.orderBy(environments.createdAt);
}

export async function getEnvironment(id: string) {
	const results = await db
		.select()
		.from(environments)
		.where(eq(environments.id, id));
	return results[0] || null;
}

export async function getEnvironmentByName(projectId: string, name: string) {
	const results = await db
		.select()
		.from(environments)
		.where(
			and(eq(environments.projectId, projectId), eq(environments.name, name)),
		);
	return results[0] || null;
}

export async function getSetting<T>(key: string): Promise<T | null> {
	const results = await db.select().from(settings).where(eq(settings.key, key));
	return (results[0]?.value as T) ?? null;
}

export async function getGlobalSettings() {
	const [
		buildServers,
		excludedServers,
		buildTimeout,
		backupConfig,
		acmeEmail,
		proxyDomain,
	] = await Promise.all([
		getSetting<string[]>("servers_allowed_for_builds"),
		getSetting<string[]>("servers_excluded_from_workload_placement"),
		getSetting<number>("build_timeout_minutes"),
		getSetting<BackupStorageConfig>("backup_storage_config"),
		getSetting<string>("acme_email"),
		getSetting<string>("proxy_domain"),
	]);

	return {
		buildServerIds: buildServers ?? [],
		excludedServerIds: excludedServers ?? [],
		buildTimeoutMinutes: buildTimeout ?? 30,
		backupStorage: backupConfig ?? null,
		acmeEmail: acmeEmail ?? null,
		proxyDomain: proxyDomain ?? null,
	};
}

type BackupStorageConfig = {
	provider: string;
	bucket: string;
	region: string;
	endpoint: string;
	accessKey: string;
	secretKey: string;
	retentionDays: number;
};

export async function getBackupStorageConfig() {
	const config = await getSetting<BackupStorageConfig>("backup_storage_config");

	if (
		!config?.provider ||
		!config?.bucket ||
		!config?.accessKey ||
		!config?.secretKey
	) {
		return null;
	}

	return config;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
	await db.insert(settings).values({ key, value }).onConflictDoUpdate({
		target: settings.key,
		set: { value },
	});
}
