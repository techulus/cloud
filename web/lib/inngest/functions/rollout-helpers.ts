import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	secrets,
	servers,
	servicePorts,
	serviceReplicas,
	services,
	serviceVolumes,
} from "@/db/schema";
import { calculateSpreadPlacement } from "@/lib/placement";
import { getCertificate, issueCertificate } from "@/lib/acme-manager";
import { assignContainerIp } from "@/lib/wireguard";
import { enqueueWork } from "@/lib/work-queue";
import { buildCurrentConfig } from "@/lib/service-config";
import { getService } from "@/db/queries";

const PORT_RANGE_START = 30000;
const PORT_RANGE_END = 32767;

export type Placement = { serverId: string; replicas: number };

export type DeploymentContext = {
	service: NonNullable<Awaited<ReturnType<typeof getService>>>;
	placements: Placement[];
	serverMap: Map<
		string,
		{ id: string; name: string; wireguardIp: string | null; status: string }
	>;
	totalReplicas: number;
	isRollingUpdate: boolean;
};

export function normalizeImage(image: string): string {
	if (!image.includes("/")) {
		return `docker.io/library/${image}`;
	}
	if (!image.includes(".") && image.split("/").length === 2) {
		return `docker.io/${image}`;
	}
	return image;
}

async function getUsedPorts(serverId: string): Promise<Set<number>> {
	const existingPorts = await db
		.select({ hostPort: deploymentPorts.hostPort })
		.from(deploymentPorts)
		.innerJoin(deployments, eq(deploymentPorts.deploymentId, deployments.id))
		.where(eq(deployments.serverId, serverId));

	return new Set(existingPorts.map((p) => p.hostPort));
}

export async function allocateHostPorts(
	serverId: string,
	count: number,
): Promise<number[]> {
	const usedPorts = await getUsedPorts(serverId);
	const allocated: number[] = [];

	for (
		let port = PORT_RANGE_START;
		port <= PORT_RANGE_END && allocated.length < count;
		port++
	) {
		if (!usedPorts.has(port)) {
			allocated.push(port);
		}
	}

	if (allocated.length < count) {
		throw new Error("Not enough available ports on this server");
	}

	return allocated;
}

export async function validateDeploymentPreconditions(
	serviceId: string,
): Promise<{
	valid: boolean;
	error?: string;
	migrationNeeded?: { targetServerId: string };
}> {
	const service = await getService(serviceId);
	if (!service) {
		return { valid: false, error: "Service not found" };
	}

	const existingDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const inProgressStatuses = [
		"pending",
		"pulling",
		"starting",
		"healthy",
		"stopping",
	];

	const hasInProgressDeployment = existingDeployments.some((d) =>
		inProgressStatuses.includes(d.status),
	);

	if (hasInProgressDeployment) {
		return { valid: false, error: "A deployment is already in progress" };
	}

	return { valid: true };
}

export async function calculateServicePlacements(
	service: NonNullable<Awaited<ReturnType<typeof getService>>>,
): Promise<{
	placements: Placement[];
	totalReplicas: number;
	migrationNeeded?: { targetServerId: string };
}> {
	let placements: Placement[];

	if (service.autoPlace && !service.stateful) {
		const totalReplicas = service.replicas;
		if (totalReplicas < 1) {
			throw new Error("At least one replica is required");
		}
		if (totalReplicas > 10) {
			throw new Error("Maximum 10 replicas allowed");
		}

		const calculatedPlacements = await calculateSpreadPlacement(totalReplicas);

		await db
			.delete(serviceReplicas)
			.where(eq(serviceReplicas.serviceId, service.id));

		for (const placement of calculatedPlacements) {
			await db.insert(serviceReplicas).values({
				id: randomUUID(),
				serviceId: service.id,
				serverId: placement.serverId,
				count: placement.count,
			});
		}

		placements = calculatedPlacements.map((p) => ({
			serverId: p.serverId,
			replicas: p.count,
		}));

		return { placements, totalReplicas };
	}

	const configuredReplicas = await db
		.select({
			serverId: serviceReplicas.serverId,
			replicas: serviceReplicas.count,
		})
		.from(serviceReplicas)
		.where(eq(serviceReplicas.serviceId, service.id));

	placements = configuredReplicas.filter((p) => p.replicas > 0);

	const totalReplicas = placements.reduce((sum, p) => sum + p.replicas, 0);
	if (totalReplicas < 1) {
		throw new Error("At least one replica is required");
	}
	if (totalReplicas > 10) {
		throw new Error("Maximum 10 replicas allowed");
	}

	if (service.stateful) {
		if (totalReplicas !== 1) {
			throw new Error("Stateful services can only have exactly 1 replica");
		}

		const serverIds = placements.map((p) => p.serverId);
		if (serverIds.length !== 1) {
			throw new Error(
				"Stateful services must be deployed to exactly one server",
			);
		}

		const targetServerId = serverIds[0];
		if (service.lockedServerId && service.lockedServerId !== targetServerId) {
			if (service.migrationStatus) {
				throw new Error("Migration already in progress");
			}
			return { placements, totalReplicas, migrationNeeded: { targetServerId } };
		}
	}

	return { placements, totalReplicas };
}

export async function validateServers(
	placements: Placement[],
): Promise<
	Map<
		string,
		{ id: string; name: string; wireguardIp: string | null; status: string }
	>
> {
	const serverIds = placements.map((p) => p.serverId);
	if (serverIds.length === 0) {
		throw new Error("No servers selected for deployment");
	}

	const selectedServers = await db
		.select()
		.from(servers)
		.where(inArray(servers.id, serverIds));

	const serverMap = new Map(selectedServers.map((s) => [s.id, s]));

	for (const placement of placements) {
		if (placement.replicas > 0) {
			const server = serverMap.get(placement.serverId);
			if (!server) {
				throw new Error(`Server ${placement.serverId} not found`);
			}
			if (server.status !== "online") {
				throw new Error(`Server ${server.name} is not online`);
			}
			if (!server.wireguardIp) {
				throw new Error(`Server ${server.name} has no WireGuard IP`);
			}
		}
	}

	return serverMap;
}

export async function prepareRollingUpdate(
	serviceId: string,
): Promise<{ deploymentIds: string[] }> {
	const existingDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const runningDeployments = existingDeployments.filter(
		(d) => d.status === "running" || d.status === "healthy",
	);

	for (const dep of runningDeployments) {
		await db
			.update(deployments)
			.set({ status: "draining" })
			.where(eq(deployments.id, dep.id));
	}

	return { deploymentIds: runningDeployments.map((d) => d.id) };
}

export async function cleanupExistingDeployments(
	serviceId: string,
): Promise<void> {
	const existingDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	for (const dep of existingDeployments) {
		await db
			.delete(deploymentPorts)
			.where(eq(deploymentPorts.deploymentId, dep.id));
		await db.delete(deployments).where(eq(deployments.id, dep.id));
	}
}

export async function issueCertificatesForService(
	serviceId: string,
): Promise<void> {
	const servicePortsList = await db
		.select()
		.from(servicePorts)
		.where(eq(servicePorts.serviceId, serviceId));

	const domainsNeedingCerts = servicePortsList
		.filter((p) => p.isPublic && p.domain)
		.map((p) => p.domain as string);

	for (const domain of domainsNeedingCerts) {
		const existingCert = await getCertificate(domain);
		if (!existingCert) {
			try {
				await issueCertificate(domain);
				console.log(`[deploy] issued certificate for ${domain}`);
			} catch (error) {
				console.error(
					`[deploy] failed to issue certificate for ${domain}:`,
					error,
				);
			}
		}
	}
}

export async function createDeploymentRecords(
	rolloutId: string,
	serviceId: string,
	context: DeploymentContext,
): Promise<{ deploymentIds: string[] }> {
	const { service, placements, serverMap, totalReplicas } = context;

	const servicePortsList = await db
		.select()
		.from(servicePorts)
		.where(eq(servicePorts.serviceId, serviceId));

	const serviceSecrets = await db
		.select()
		.from(secrets)
		.where(eq(secrets.serviceId, serviceId));

	const volumes = await db
		.select()
		.from(serviceVolumes)
		.where(eq(serviceVolumes.serviceId, serviceId));

	const env: Record<string, string> = {};
	for (const secret of serviceSecrets) {
		env[secret.key] = secret.encryptedValue;
	}

	const updateData: { replicas: number; lockedServerId?: string } = {
		replicas: totalReplicas,
	};

	if (service.stateful && !service.lockedServerId) {
		updateData.lockedServerId = placements.map((p) => p.serverId)[0];
	}

	await db.update(services).set(updateData).where(eq(services.id, serviceId));

	const deploymentIds: string[] = [];
	let replicaIndex = 0;

	for (const placement of placements) {
		if (placement.replicas <= 0) continue;

		const server = serverMap.get(placement.serverId)!;

		for (let i = 0; i < placement.replicas; i++) {
			replicaIndex++;
			const hostPorts = await allocateHostPorts(
				server.id,
				servicePortsList.length,
			);
			const ipAddress = await assignContainerIp(server.id);

			const deploymentId = randomUUID();
			deploymentIds.push(deploymentId);

			await db.insert(deployments).values({
				id: deploymentId,
				serviceId,
				serverId: server.id,
				ipAddress,
				status: "pending",
				rolloutId,
			});

			const portMappings: { containerPort: number; hostPort: number }[] = [];
			for (let j = 0; j < servicePortsList.length; j++) {
				const sp = servicePortsList[j];
				const hostPort = hostPorts[j];

				await db.insert(deploymentPorts).values({
					id: randomUUID(),
					deploymentId,
					servicePortId: sp.id,
					hostPort,
				});

				portMappings.push({ containerPort: sp.port, hostPort });
			}

			const healthCheck = service.healthCheckCmd
				? {
						cmd: service.healthCheckCmd,
						interval: service.healthCheckInterval ?? 10,
						timeout: service.healthCheckTimeout ?? 5,
						retries: service.healthCheckRetries ?? 3,
						startPeriod: service.healthCheckStartPeriod ?? 30,
					}
				: null;

			const volumeMounts = volumes.map((v) => ({
				name: v.name,
				containerPath: v.containerPath,
			}));

			await enqueueWork(server.id, "deploy", {
				deploymentId,
				serviceId,
				serviceName: service.name,
				image: normalizeImage(service.image),
				portMappings,
				wireguardIp: server.wireguardIp,
				ipAddress,
				name: `${serviceId}-${replicaIndex}`,
				healthCheck,
				env,
				volumeMounts,
			});
		}
	}

	return { deploymentIds };
}

export async function saveDeployedConfig(
	serviceId: string,
	context: DeploymentContext,
): Promise<void> {
	const { placements, serverMap } = context;

	const servicePortsList = await db
		.select()
		.from(servicePorts)
		.where(eq(servicePorts.serviceId, serviceId));

	const serviceSecrets = await db
		.select()
		.from(secrets)
		.where(eq(secrets.serviceId, serviceId));

	const volumes = await db
		.select()
		.from(serviceVolumes)
		.where(eq(serviceVolumes.serviceId, serviceId));

	const replicaConfigs = placements
		.filter((p) => p.replicas > 0)
		.map((p) => ({
			serverId: p.serverId,
			serverName: serverMap.get(p.serverId)?.name ?? "Unknown",
			count: p.replicas,
		}));

	const portConfigs = servicePortsList.map((p) => ({
		port: p.port,
		isPublic: p.isPublic,
		domain: p.domain,
	}));

	const updatedService = await getService(serviceId);
	if (updatedService) {
		const deployedConfig = buildCurrentConfig(
			updatedService,
			replicaConfigs,
			portConfigs,
			serviceSecrets,
			volumes,
		);

		await db
			.update(services)
			.set({ deployedConfig: JSON.stringify(deployedConfig) })
			.where(eq(services.id, serviceId));
	}
}

export async function checkForRollingUpdate(
	serviceId: string,
): Promise<boolean> {
	const service = await getService(serviceId);
	if (!service || service.stateful) {
		return false;
	}

	const existingDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const runningDeployments = existingDeployments.filter(
		(d) => d.status === "running" || d.status === "healthy",
	);

	return runningDeployments.length > 0;
}
