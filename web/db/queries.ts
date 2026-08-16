import {
	and,
	count,
	countDistinct,
	eq,
	inArray,
	isNotNull,
	isNull,
} from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import {
	deployments,
	environments,
	projects,
	servers,
	services,
	settings,
} from "@/db/schema";
import type {
	ControlPlaneUpdateState,
	ControlPlaneUpgradeState,
} from "@/lib/control-plane-updates";
import { observedReadyPhases } from "@/lib/deployment-status";
import type {
	EmailAlertsConfig,
	SmtpConfig,
	SmtpEncryption,
} from "@/lib/settings-keys";
import {
	DEFAULT_BACKUP_RETENTION_DAYS,
	DEFAULT_SMTP_PORT,
	DEFAULT_SMTP_TIMEOUT,
} from "@/lib/settings-keys";

export async function listProjects() {
	const [projectList, serviceCounts, onlineCounts, environmentCounts] =
		await Promise.all([
			db.select().from(projects).orderBy(projects.createdAt),
			db
				.select({ projectId: services.projectId, total: count() })
				.from(services)
				.where(
					and(isNull(services.deletedAt), isNull(services.previewOfServiceId)),
				)
				.groupBy(services.projectId),
			db
				.select({
					projectId: services.projectId,
					online: countDistinct(services.id),
				})
				.from(services)
				.innerJoin(deployments, eq(deployments.serviceId, services.id))
				.where(
					and(
						isNull(services.deletedAt),
						isNull(services.previewOfServiceId),
						inArray(deployments.observedPhase, [...observedReadyPhases]),
					),
				)
				.groupBy(services.projectId),
			db
				.select({ projectId: environments.projectId, total: count() })
				.from(environments)
				.groupBy(environments.projectId),
		]);

	const totalByProject = new Map(
		serviceCounts.map((row) => [row.projectId, row.total]),
	);
	const onlineByProject = new Map(
		onlineCounts.map((row) => [row.projectId, row.online]),
	);
	const environmentsByProject = new Map(
		environmentCounts.map((row) => [row.projectId, row.total]),
	);

	return projectList.map((project) => ({
		...project,
		serviceCount: totalByProject.get(project.id) ?? 0,
		onlineServiceCount: onlineByProject.get(project.id) ?? 0,
		environmentCount: environmentsByProject.get(project.id) ?? 0,
	}));
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

export async function getService(id: string) {
	const results = await db
		.select()
		.from(services)
		.where(
			and(
				eq(services.id, id),
				isNull(services.deletedAt),
				isNull(services.previewOfServiceId),
			),
		);
	return results[0] || null;
}

export async function getRuntimeService(id: string) {
	const results = await db
		.select()
		.from(services)
		.where(and(eq(services.id, id), isNull(services.deletedAt)));
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
						isNull(services.previewOfServiceId),
					)
				: and(
						eq(services.projectId, projectId),
						isNotNull(services.deletedAt),
						isNull(services.previewOfServiceId),
					),
		)
		.orderBy(services.deletedAt);
}

export async function listServers() {
	return db.select().from(servers).orderBy(servers.createdAt);
}

export const getServerDetails = cache(async (id: string) => {
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
			crowdsecHealth: servers.crowdsecHealth,
			agentUpgradeTargetVersion: servers.agentUpgradeTargetVersion,
			agentUpgradeStatus: servers.agentUpgradeStatus,
			agentUpgradeStartedAt: servers.agentUpgradeStartedAt,
			agentUpgradeError: servers.agentUpgradeError,
		})
		.from(servers)
		.where(eq(servers.id, id));

	const server = serverResults[0];
	return server ? { ...server, healthStats: null } : null;
});

export async function getClusterHealth() {
	const allServers = await db
		.select({
			id: servers.id,
			status: servers.status,
			networkHealth: servers.networkHealth,
			containerHealth: servers.containerHealth,
			agentHealth: servers.agentHealth,
		})
		.from(servers);

	const onlineServers = allServers.filter((s) => s.status === "online");

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
			networkHealthy,
			containerHealthy,
		},
		servers: allServers.map((server) => ({
			id: server.id,
			networkHealth: server.networkHealth,
			containerHealth: server.containerHealth,
			agentHealth: server.agentHealth,
		})),
	};
}

export async function getServerServices(serverId: string) {
	const results = await db
		.selectDistinctOn([services.id], {
			deploymentId: deployments.id,
			deploymentStatus: deployments.observedPhase,
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
		edgeDomain,
		autoSubdomainDomain,
		emailAlertsConfig,
		controlPlaneUpdateState,
		controlPlaneUpgradeState,
	] = await Promise.all([
		getSetting<string[]>("servers_allowed_for_builds"),
		getSetting<number>("build_timeout_minutes"),
		getSetting<string>("acme_email"),
		getSetting<string>("edge_domain"),
		getSetting<string>("auto_subdomain_domain"),
		getSetting<EmailAlertsConfig>("email_alerts_config"),
		getSetting<ControlPlaneUpdateState>("control_plane_update_state"),
		getSetting<ControlPlaneUpgradeState>("control_plane_upgrade_state"),
	]);
	return {
		buildServerIds: buildServers ?? [],
		buildTimeoutMinutes: buildTimeout ?? 30,
		acmeEmail: acmeEmail ?? null,
		edgeDomain: {
			hostname: edgeDomain ?? null,
		},
		autoSubdomainDomain: autoSubdomainDomain ?? null,
		emailAlertsConfig: emailAlertsConfig ?? null,
		controlPlaneUpdateState: controlPlaneUpdateState ?? null,
		controlPlaneUpgradeState: controlPlaneUpgradeState ?? null,
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

	const configuredRetentionDays = Number(
		process.env.BACKUP_STORAGE_RETENTION_DAYS ?? DEFAULT_BACKUP_RETENTION_DAYS,
	);
	const retentionDays =
		Number.isInteger(configuredRetentionDays) &&
		configuredRetentionDays >= 1 &&
		configuredRetentionDays <= 3_650
			? configuredRetentionDays
			: DEFAULT_BACKUP_RETENTION_DAYS;

	if (retentionDays !== configuredRetentionDays) {
		console.warn(
			`[backup-storage] invalid BACKUP_STORAGE_RETENTION_DAYS; using ${DEFAULT_BACKUP_RETENTION_DAYS}`,
		);
	}

	return {
		provider,
		bucket,
		region: process.env.BACKUP_STORAGE_REGION ?? "",
		endpoint: process.env.BACKUP_STORAGE_ENDPOINT ?? "",
		accessKey,
		secretKey,
		retentionDays,
	};
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
	await db.insert(settings).values({ key, value }).onConflictDoUpdate({
		target: settings.key,
		set: { value },
	});
}
