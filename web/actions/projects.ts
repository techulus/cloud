"use server";

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	projects,
	rollouts,
	secrets,
	servers,
	servicePorts,
	serviceReplicas,
	services,
	workQueue,
} from "@/db/schema";
import {
	buildCurrentConfig,
	type HealthCheckConfig as ServiceHealthCheckConfig,
	type PortConfig,
} from "@/lib/service-config";
import { assignContainerIp } from "@/lib/wireguard";
import { slugify } from "@/lib/utils";
import { getService } from "@/db/queries";

function parseImageReference(image: string): {
	registry: string;
	namespace: string;
	repository: string;
	tag: string | null;
	digest: string | null;
} {
	let registry = "docker.io";
	let namespace = "library";
	let repository: string;
	let tag: string | null = "latest";
	let digest: string | null = null;
	let imagePath = image;

	const digestIndex = imagePath.indexOf("@");
	if (digestIndex !== -1) {
		digest = imagePath.substring(digestIndex + 1);
		imagePath = imagePath.substring(0, digestIndex);
		tag = null;
	} else {
		const tagIndex = imagePath.lastIndexOf(":");
		if (tagIndex !== -1 && !imagePath.substring(tagIndex).includes("/")) {
			tag = imagePath.substring(tagIndex + 1);
			imagePath = imagePath.substring(0, tagIndex);
		}
	}

	const parts = imagePath.split("/");

	if (parts.length === 1) {
		repository = parts[0];
	} else if (parts.length === 2) {
		if (parts[0].includes(".") || parts[0].includes(":")) {
			registry = parts[0];
			repository = parts[1];
		} else {
			namespace = parts[0];
			repository = parts[1];
		}
	} else {
		registry = parts[0];
		namespace = parts.slice(1, -1).join("/");
		repository = parts[parts.length - 1];
	}

	return { registry, namespace, repository, tag, digest };
}

export async function validateDockerImage(
	image: string,
): Promise<{ valid: boolean; error?: string }> {
	try {
		const { registry, namespace, repository, tag, digest } = parseImageReference(image);
		const reference = digest || tag || "latest";

		if (registry === "docker.io") {
			const repoPath = namespace === "library" ? repository : `${namespace}/${repository}`;

			if (digest) {
				const tokenUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${namespace === "library" ? "library/" : ""}${repoPath}:pull`;
				const tokenResponse = await fetch(tokenUrl);
				if (!tokenResponse.ok) {
					return { valid: false, error: "Failed to authenticate with Docker Hub" };
				}
				const tokenData = await tokenResponse.json();
				const token = tokenData.token;

				const manifestUrl = `https://registry-1.docker.io/v2/${namespace === "library" ? "library/" : ""}${repoPath}/manifests/${digest}`;
				const manifestResponse = await fetch(manifestUrl, {
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
					},
				});

				if (manifestResponse.status === 404) {
					return { valid: false, error: "Image digest not found on Docker Hub" };
				}
				if (!manifestResponse.ok) {
					return { valid: false, error: "Failed to validate image" };
				}
				return { valid: true };
			}

			const url = `https://hub.docker.com/v2/repositories/${repoPath}/tags/${reference}`;
			const response = await fetch(url, { method: "GET" });

			if (response.status === 404) {
				return { valid: false, error: "Image or tag not found on Docker Hub" };
			}
			if (!response.ok) {
				return { valid: false, error: "Failed to validate image" };
			}
			return { valid: true };
		}

		if (registry === "ghcr.io") {
			const tokenUrl = `https://ghcr.io/token?scope=repository:${namespace}/${repository}:pull`;
			const tokenResponse = await fetch(tokenUrl);
			if (!tokenResponse.ok) {
				return { valid: false, error: "Image not found on GitHub Container Registry" };
			}
			const tokenData = await tokenResponse.json();
			const token = tokenData.token;

			const manifestUrl = `https://ghcr.io/v2/${namespace}/${repository}/manifests/${reference}`;
			const manifestResponse = await fetch(manifestUrl, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
				},
			});

			if (manifestResponse.status === 404) {
				return { valid: false, error: `Image ${digest ? "digest" : "tag"} not found on GitHub Container Registry` };
			}
			if (!manifestResponse.ok) {
				return { valid: false, error: "Failed to validate image" };
			}
			return { valid: true };
		}

		return { valid: true };
	} catch (error) {
		console.error("Image validation error:", error);
		return { valid: false, error: "Failed to validate image" };
	}
}

function normalizeImage(image: string): string {
	if (!image.includes("/")) {
		return `docker.io/library/${image}`;
	}
	if (!image.includes(".") && image.split("/").length === 2) {
		return `docker.io/${image}`;
	}
	return image;
}

export async function createProject(name: string) {
	const id = randomUUID();
	const slug = slugify(name);

	await db.insert(projects).values({
		id,
		name,
		slug,
	});

	return { id, name, slug };
}

export async function deleteProject(id: string) {
	await db.delete(projects).where(eq(projects.id, id));
}

export async function updateProject(id: string, name: string) {
	const trimmed = name.trim();
	if (!trimmed) {
		throw new Error("Project name cannot be empty");
	}

	const slug = slugify(trimmed);
	if (!slug) {
		throw new Error("Invalid project name");
	}

	const existing = await db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.slug, slug));

	if (existing.some((p) => p.id !== id)) {
		throw new Error("A project with this name already exists");
	}

	await db
		.update(projects)
		.set({ name: trimmed, slug })
		.where(eq(projects.id, id));

	return { id, name: trimmed, slug };
}

export async function createService(
	projectId: string,
	name: string,
	image: string,
	ports: number[],
) {
	const id = randomUUID();
	const hostname = slugify(name);

	await db.insert(services).values({
		id,
		projectId,
		name,
		hostname,
		image,
		replicas: 0,
	});

	for (const port of ports) {
		await db.insert(servicePorts).values({
			id: randomUUID(),
			serviceId: id,
			port,
		});
	}

	return { id, name, image, ports };
}

export type ServerPlacement = {
	serverId: string;
	replicas: number;
};

export async function deleteService(serviceId: string) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	const activeDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const activeStatuses = [
		"pending",
		"pulling",
		"starting",
		"healthy",
		"dns_updating",
		"caddy_updating",
		"stopping_old",
		"running",
		"stopping",
	];
	const hasActiveDeployments = activeDeployments.some(
		(d) => activeStatuses.includes(d.status)
	);

	if (hasActiveDeployments) {
		throw new Error("Stop all deployments before deleting the service");
	}

	for (const deployment of activeDeployments) {
		await db.delete(deploymentPorts).where(eq(deploymentPorts.deploymentId, deployment.id));
	}
	await db.delete(deployments).where(eq(deployments.serviceId, serviceId));
	await db.delete(secrets).where(eq(secrets.serviceId, serviceId));
	await db.delete(services).where(eq(services.id, serviceId));

	return { success: true };
}

export async function updateServiceName(serviceId: string, name: string) {
	const trimmed = name.trim();
	if (!trimmed) {
		throw new Error("Service name cannot be empty");
	}

	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	await db
		.update(services)
		.set({ name: trimmed })
		.where(eq(services.id, serviceId));

	return { success: true };
}

export async function updateServiceHostname(serviceId: string, hostname: string) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	const sanitized = slugify(hostname);
	if (!sanitized) {
		throw new Error("Invalid hostname");
	}

	const existing = await db
		.select({ id: services.id })
		.from(services)
		.where(eq(services.hostname, sanitized));

	if (existing.some((s) => s.id !== serviceId)) {
		throw new Error("Hostname is already in use");
	}

	await db
		.update(services)
		.set({ hostname: sanitized })
		.where(eq(services.id, serviceId));

	return { success: true, hostname: sanitized };
}

type PortChange = {
	action: "add" | "remove";
	portId?: string;
	port?: number;
	isPublic?: boolean;
	domain?: string;
};

export async function updateServicePorts(serviceId: string, changes: PortChange[]) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	for (const change of changes) {
		if (change.action === "remove" && change.portId) {
			await db.delete(deploymentPorts).where(eq(deploymentPorts.servicePortId, change.portId));
			await db.delete(servicePorts).where(eq(servicePorts.id, change.portId));
		} else if (change.action === "add" && change.port) {
			const existing = await db
				.select()
				.from(servicePorts)
				.where(eq(servicePorts.serviceId, serviceId));

			if (existing.some((p) => p.port === change.port)) {
				throw new Error(`Port ${change.port} already exists`);
			}

			if (change.isPublic) {
				if (!change.domain) {
					throw new Error("Domain is required for public ports");
				}

				const domain = change.domain.trim().toLowerCase();
				if (!domain) {
					throw new Error("Invalid domain");
				}

				const existingDomain = await db
					.select()
					.from(servicePorts)
					.where(eq(servicePorts.domain, domain));

				if (existingDomain.length > 0) {
					throw new Error("Domain already in use");
				}

				await db.insert(servicePorts).values({
					id: randomUUID(),
					serviceId,
					port: change.port,
					isPublic: true,
					domain,
				});
			} else {
				await db.insert(servicePorts).values({
					id: randomUUID(),
					serviceId,
					port: change.port,
					isPublic: false,
				});
			}
		}
	}

	const existingDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const runningDeployments = existingDeployments.filter((d) => d.status === "running");

	if (runningDeployments.length > 0) {
		const placementMap = new Map<string, number>();
		for (const dep of runningDeployments) {
			placementMap.set(dep.serverId, (placementMap.get(dep.serverId) || 0) + 1);
		}
		const placements: ServerPlacement[] = Array.from(placementMap.entries()).map(
			([serverId, replicas]) => ({ serverId, replicas })
		);
		await deployService(serviceId, placements);
	}

	return { success: true, redeployed: runningDeployments.length > 0 };
}

const PORT_RANGE_START = 30000;
const PORT_RANGE_END = 32767;

async function getUsedPorts(serverId: string): Promise<Set<number>> {
	const existingPorts = await db
		.select({ hostPort: deploymentPorts.hostPort })
		.from(deploymentPorts)
		.innerJoin(deployments, eq(deploymentPorts.deploymentId, deployments.id))
		.where(eq(deployments.serverId, serverId));

	return new Set(existingPorts.map((p) => p.hostPort));
}

async function allocateHostPorts(
	serverId: string,
	count: number,
): Promise<number[]> {
	const usedPorts = await getUsedPorts(serverId);
	const allocated: number[] = [];

	for (let port = PORT_RANGE_START; port <= PORT_RANGE_END && allocated.length < count; port++) {
		if (!usedPorts.has(port)) {
			allocated.push(port);
		}
	}

	if (allocated.length < count) {
		throw new Error("Not enough available ports on this server");
	}

	return allocated;
}

export async function deployService(serviceId: string, placements: ServerPlacement[]) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	const totalReplicas = placements.reduce((sum, p) => sum + p.replicas, 0);
	if (totalReplicas < 1) {
		throw new Error("At least one replica is required");
	}
	if (totalReplicas > 10) {
		throw new Error("Maximum 10 replicas allowed");
	}

	const serverIds = placements.filter(p => p.replicas > 0).map(p => p.serverId);
	if (serverIds.length === 0) {
		throw new Error("No servers selected for deployment");
	}

	const selectedServers = await db
		.select()
		.from(servers)
		.where(inArray(servers.id, serverIds));

	const serverMap = new Map(selectedServers.map(s => [s.id, s]));

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

	const existingDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const inProgressStatuses = [
		"pending",
		"pulling",
		"starting",
		"healthy",
		"dns_updating",
		"caddy_updating",
		"stopping_old",
		"stopping",
	];

	const hasInProgressDeployment = existingDeployments.some(
		(d) => inProgressStatuses.includes(d.status)
	);

	if (hasInProgressDeployment) {
		throw new Error("A deployment is already in progress");
	}

	const rolloutId = randomUUID();
	const oldRunningDeployments = existingDeployments.filter(
		(d) => d.status === "running" && d.containerId
	);

	await db.insert(rollouts).values({
		id: rolloutId,
		serviceId,
		status: "in_progress",
		currentStage: "deploying",
	});

	for (const dep of existingDeployments) {
		if (dep.status !== "running") {
			await db.delete(deploymentPorts).where(eq(deploymentPorts.deploymentId, dep.id));
			await db.delete(deployments).where(eq(deployments.id, dep.id));
		}
	}

	const servicePortsList = await db
		.select()
		.from(servicePorts)
		.where(eq(servicePorts.serviceId, serviceId));

	const serviceSecrets = await db
		.select()
		.from(secrets)
		.where(eq(secrets.serviceId, serviceId));

	const env: Record<string, string> = {};
	for (const secret of serviceSecrets) {
		env[secret.key] = secret.encryptedValue;
	}

	await db
		.update(services)
		.set({ replicas: totalReplicas })
		.where(eq(services.id, serviceId));

	const deploymentIds: string[] = [];
	let replicaIndex = 0;

	for (const placement of placements) {
		if (placement.replicas <= 0) continue;

		const server = serverMap.get(placement.serverId)!;

		for (let i = 0; i < placement.replicas; i++) {
			replicaIndex++;
			const hostPorts = await allocateHostPorts(server.id, servicePortsList.length);
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

			await db.insert(workQueue).values({
				id: randomUUID(),
				serverId: server.id,
				type: "deploy",
				payload: JSON.stringify({
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
				}),
			});
		}
	}

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
		);

		await db
			.update(services)
			.set({ deployedConfig: JSON.stringify(deployedConfig) })
			.where(eq(services.id, serviceId));
	}

	return { deploymentIds, replicaCount: totalReplicas, rolloutId };
}

export async function deleteDeployment(deploymentId: string) {
	const deployment = await db
		.select()
		.from(deployments)
		.where(eq(deployments.id, deploymentId));

	if (!deployment[0]) {
		throw new Error("Deployment not found");
	}

	const dep = deployment[0];

	if (dep.status === "running" || dep.status === "pulling") {
		throw new Error("Stop the deployment before deleting");
	}

	await db.delete(deployments).where(eq(deployments.id, deploymentId));

	return { success: true };
}

export type HealthCheckConfig = {
	cmd: string | null;
	interval: number;
	timeout: number;
	retries: number;
	startPeriod: number;
};

export async function updateServiceHealthCheck(
	serviceId: string,
	config: HealthCheckConfig
) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	await db
		.update(services)
		.set({
			healthCheckCmd: config.cmd,
			healthCheckInterval: config.interval,
			healthCheckTimeout: config.timeout,
			healthCheckRetries: config.retries,
			healthCheckStartPeriod: config.startPeriod,
		})
		.where(eq(services.id, serviceId));

	return { success: true };
}

export type ServiceConfigUpdate = {
	source?: { type: "image"; image: string };
	healthCheck?: ServiceHealthCheckConfig | null;
	ports?: { add?: PortConfig[]; remove?: string[] };
	replicas?: { serverId: string; count: number }[];
};

export async function updateServiceConfig(
	serviceId: string,
	config: ServiceConfigUpdate,
) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	if (config.source) {
		await db
			.update(services)
			.set({ image: config.source.image })
			.where(eq(services.id, serviceId));
	}

	if (config.healthCheck !== undefined) {
		if (config.healthCheck === null) {
			await db
				.update(services)
				.set({
					healthCheckCmd: null,
					healthCheckInterval: null,
					healthCheckTimeout: null,
					healthCheckRetries: null,
					healthCheckStartPeriod: null,
				})
				.where(eq(services.id, serviceId));
		} else {
			await db
				.update(services)
				.set({
					healthCheckCmd: config.healthCheck.cmd,
					healthCheckInterval: config.healthCheck.interval,
					healthCheckTimeout: config.healthCheck.timeout,
					healthCheckRetries: config.healthCheck.retries,
					healthCheckStartPeriod: config.healthCheck.startPeriod,
				})
				.where(eq(services.id, serviceId));
		}
	}

	if (config.ports) {
		if (config.ports.remove && config.ports.remove.length > 0) {
			for (const portId of config.ports.remove) {
				await db.delete(deploymentPorts).where(eq(deploymentPorts.servicePortId, portId));
				await db.delete(servicePorts).where(eq(servicePorts.id, portId));
			}
		}

		if (config.ports.add && config.ports.add.length > 0) {
			const existing = await db
				.select()
				.from(servicePorts)
				.where(eq(servicePorts.serviceId, serviceId));

			for (const port of config.ports.add) {
				if (existing.some((p) => p.port === port.port)) {
					throw new Error(`Port ${port.port} already exists`);
				}

				if (port.isPublic) {
					if (!port.domain) {
						throw new Error("Domain is required for public ports");
					}

					const domain = port.domain.trim().toLowerCase();
					if (!domain) {
						throw new Error("Invalid domain");
					}

					const existingDomain = await db
						.select()
						.from(servicePorts)
						.where(eq(servicePorts.domain, domain));

					if (existingDomain.length > 0) {
						throw new Error("Domain already in use");
					}

					await db.insert(servicePorts).values({
						id: randomUUID(),
						serviceId,
						port: port.port,
						isPublic: true,
						domain,
					});
				} else {
					await db.insert(servicePorts).values({
						id: randomUUID(),
						serviceId,
						port: port.port,
						isPublic: false,
					});
				}
			}
		}
	}

	if (config.replicas) {
		await db.delete(serviceReplicas).where(eq(serviceReplicas.serviceId, serviceId));

		for (const replica of config.replicas) {
			if (replica.count > 0) {
				await db.insert(serviceReplicas).values({
					id: randomUUID(),
					serviceId,
					serverId: replica.serverId,
					count: replica.count,
				});
			}
		}
	}

	return { success: true };
}

export async function stopDeployment(deploymentId: string) {
	const deployment = await db
		.select()
		.from(deployments)
		.where(eq(deployments.id, deploymentId));

	if (!deployment[0]) {
		throw new Error("Deployment not found");
	}

	const dep = deployment[0];

	if (!dep.containerId) {
		throw new Error("No container to stop");
	}

	await db
		.update(deployments)
		.set({ status: "stopping" })
		.where(eq(deployments.id, deploymentId));

	await db.insert(workQueue).values({
		id: randomUUID(),
		serverId: dep.serverId,
		type: "stop",
		payload: JSON.stringify({
			deploymentId: dep.id,
			containerId: dep.containerId,
		}),
	});

	return { success: true };
}

export async function abortRollout(serviceId: string) {
	const allRollouts = await db
		.select()
		.from(rollouts)
		.where(eq(rollouts.serviceId, serviceId));

	for (const rollout of allRollouts) {
		if (rollout.status === "in_progress") {
			await db
				.update(rollouts)
				.set({ status: "failed", currentStage: "aborted", completedAt: new Date() })
				.where(eq(rollouts.id, rollout.id));
		}
	}

	const allDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const serverContainers = new Map<string, string[]>();

	for (const dep of allDeployments) {
		if (dep.containerId) {
			const containers = serverContainers.get(dep.serverId) || [];
			containers.push(dep.containerId);
			serverContainers.set(dep.serverId, containers);
		}
	}

	for (const [serverId, containerIds] of serverContainers) {
		await db.insert(workQueue).values({
			id: randomUUID(),
			serverId,
			type: "force_cleanup",
			payload: JSON.stringify({
				serviceId,
				containerIds,
			}),
		});
	}

	for (const dep of allDeployments) {
		await db.delete(deploymentPorts).where(eq(deploymentPorts.deploymentId, dep.id));
	}

	await db.delete(deployments).where(eq(deployments.serviceId, serviceId));

	await db
		.delete(workQueue)
		.where(eq(workQueue.status, "pending"));

	return { success: true };
}

