import { and, eq, isNotNull, isNull } from "drizzle-orm";
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
import type { HealthStats } from "@/db/types";
import type {
	EmailAlertsConfig,
	SmtpConfig,
	SmtpEncryption,
} from "@/lib/settings-keys";
import { DEFAULT_SMTP_PORT, DEFAULT_SMTP_TIMEOUT } from "@/lib/settings-keys";
import {
	type NodeMetricsSnapshot,
	queryNodeMetricsSnapshots,
} from "@/lib/victoria-metrics";

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
				.where(
					and(eq(services.projectId, project.id), isNull(services.deletedAt)),
				);
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
		.where(and(eq(services.projectId, projectId), isNull(services.deletedAt)))
		.orderBy(services.createdAt);
}

export async function getService(id: string) {
	const results = await db
		.select()
		.from(services)
		.where(and(eq(services.id, id), isNull(services.deletedAt)));
	return results[0] || null;
}

export async function getDeletedService(id: string) {
	const results = await db
		.select()
		.from(services)
		.where(and(eq(services.id, id), isNotNull(services.deletedAt)));
	return results[0] || null;
}

export async function listDeletedServices(
	projectId: string,
	environmentId?: string,
) {
	return db
		.select()
		.from(services)
		.where(
			environmentId
				? and(
						eq(services.projectId, projectId),
						eq(services.environmentId, environmentId),
						isNotNull(services.deletedAt),
					)
				: and(eq(services.projectId, projectId), isNotNull(services.deletedAt)),
		)
		.orderBy(services.deletedAt);
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
			networkHealth: servers.networkHealth,
			containerHealth: servers.containerHealth,
			agentHealth: servers.agentHealth,
		})
		.from(servers)
		.where(eq(servers.id, id));

	const server = serverResults[0];
	return server ? { ...server, healthStats: null } : null;
}

export async function getClusterHealth() {
	const allServers = await db
		.select({
			id: servers.id,
			name: servers.name,
			status: servers.status,
			networkHealth: servers.networkHealth,
			containerHealth: servers.containerHealth,
			agentHealth: servers.agentHealth,
		})
		.from(servers);

	const onlineServers = allServers.filter((s) => s.status === "online");
	const metricsByServer = await queryNodeMetricsSnapshots(
		onlineServers.map((server) => server.id),
	).catch((error) => {
		console.error("[cluster-health] failed to query metrics:", error);
		return new Map<string, NodeMetricsSnapshot>();
	});

	const serversWithHealth = allServers.map((server) => ({
		...server,
		healthStats: metricSnapshotToHealthStats(metricsByServer.get(server.id)),
	}));
	const serversWithCurrentMetrics = serversWithHealth.filter(
		(server) => server.status === "online" && server.healthStats,
	);

	let avgCpuUsage = 0;
	let avgMemoryUsage = 0;

	if (serversWithCurrentMetrics.length > 0) {
		const cpuSum = serversWithCurrentMetrics.reduce(
			(sum, s) => sum + (s.healthStats?.cpuUsagePercent ?? 0),
			0,
		);
		const memSum = serversWithCurrentMetrics.reduce(
			(sum, s) => sum + (s.healthStats?.memoryUsagePercent ?? 0),
			0,
		);
		avgCpuUsage = cpuSum / serversWithCurrentMetrics.length;
		avgMemoryUsage = memSum / serversWithCurrentMetrics.length;
	}

	const networkHealthy = onlineServers.filter(
		(s) => s.networkHealth?.tunnelUp,
	).length;
	const containerHealthy = onlineServers.filter(
		(s) => s.containerHealth?.runtimeResponsive,
	).length;

	return {
		summary: {
			totalServers: allServers.length,
			onlineServers: onlineServers.length,
			avgCpuUsage,
			avgMemoryUsage,
			networkHealthy,
			containerHealthy,
		},
		servers: serversWithHealth,
	};
}

export function metricSnapshotToHealthStats(
	snapshot:
		| {
				cpuUsagePercent: number | null;
				memoryUsagePercent: number | null;
				memoryUsedBytes: number | null;
				diskUsagePercent: number | null;
				diskUsedBytes: number | null;
		  }
		| null
		| undefined,
): HealthStats | null {
	if (!snapshot) return null;
	if (
		snapshot.cpuUsagePercent === null &&
		snapshot.memoryUsagePercent === null &&
		snapshot.memoryUsedBytes === null &&
		snapshot.diskUsagePercent === null &&
		snapshot.diskUsedBytes === null
	) {
		return null;
	}

	return {
		cpuUsagePercent: snapshot.cpuUsagePercent ?? 0,
		memoryUsagePercent: snapshot.memoryUsagePercent ?? 0,
		memoryUsedMb: Math.round((snapshot.memoryUsedBytes ?? 0) / 1024 / 1024),
		diskUsagePercent: snapshot.diskUsagePercent ?? 0,
		diskUsedGb: Math.round((snapshot.diskUsedBytes ?? 0) / 1024 / 1024 / 1024),
	};
}

export async function getServerServices(serverId: string) {
	const results = await db
		.selectDistinctOn([services.id], {
			deploymentId: deployments.id,
			deploymentStatus: deployments.status,
			serviceId: services.id,
			serviceName: services.name,
			serviceImage: services.image,
			projectId: projects.id,
			projectName: projects.name,
			projectSlug: projects.slug,
			environmentName: environments.name,
		})
		.from(deployments)
		.innerJoin(services, eq(deployments.serviceId, services.id))
		.innerJoin(projects, eq(services.projectId, projects.id))
		.innerJoin(environments, eq(services.environmentId, environments.id))
		.where(eq(deployments.serverId, serverId));

	return results;
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
		buildTimeout,
		acmeEmail,
		proxyDomain,
		emailAlertsConfig,
	] = await Promise.all([
		getSetting<string[]>("servers_allowed_for_builds"),
		getSetting<number>("build_timeout_minutes"),
		getSetting<string>("acme_email"),
		getSetting<string>("proxy_domain"),
		getSetting<EmailAlertsConfig>("email_alerts_config"),
	]);

	return {
		buildServerIds: buildServers ?? [],
		buildTimeoutMinutes: buildTimeout ?? 30,
		acmeEmail: acmeEmail ?? null,
		proxyDomain: proxyDomain ?? null,
		emailAlertsConfig: emailAlertsConfig ?? null,
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

export function getSmtpConfig(): SmtpConfig | null {
	const enabled = process.env.SMTP_ENABLED === "true";
	const host = process.env.SMTP_HOST;
	const fromAddress = process.env.SMTP_FROM_ADDRESS;

	if (!host || !fromAddress) {
		return null;
	}

	const port = parseInt(process.env.SMTP_PORT ?? "", 10) || DEFAULT_SMTP_PORT;
	const timeout =
		parseInt(process.env.SMTP_TIMEOUT ?? "", 10) || DEFAULT_SMTP_TIMEOUT;
	const encryption = (process.env.SMTP_ENCRYPTION ??
		"starttls") as SmtpEncryption;

	return {
		enabled,
		fromName: process.env.SMTP_FROM_NAME ?? "",
		fromAddress,
		host,
		port,
		username: process.env.SMTP_USERNAME ?? "",
		password: process.env.SMTP_PASSWORD ?? "",
		encryption,
		timeout,
		alertEmails: process.env.SMTP_ALERT_EMAILS ?? "",
	};
}

export async function getEmailAlertsConfig(): Promise<EmailAlertsConfig | null> {
	return getSetting<EmailAlertsConfig>("email_alerts_config");
}

export function getBackupStorageConfig(): BackupStorageConfig | null {
	const provider = process.env.BACKUP_STORAGE_PROVIDER;
	const bucket = process.env.BACKUP_STORAGE_BUCKET;
	const accessKey = process.env.BACKUP_STORAGE_ACCESS_KEY;
	const secretKey = process.env.BACKUP_STORAGE_SECRET_KEY;

	if (!provider || !bucket || !accessKey || !secretKey) {
		return null;
	}

	return {
		provider,
		bucket,
		region: process.env.BACKUP_STORAGE_REGION ?? "",
		endpoint: process.env.BACKUP_STORAGE_ENDPOINT ?? "",
		accessKey,
		secretKey,
		retentionDays: parseInt(
			process.env.BACKUP_STORAGE_RETENTION_DAYS ?? "7",
			10,
		),
	};
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
	await db.insert(settings).values({ key, value }).onConflictDoUpdate({
		target: settings.key,
		set: { value },
	});
}
