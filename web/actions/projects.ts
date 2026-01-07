"use server";

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	environments,
	githubRepos,
	projects,
	rollouts,
	secrets,
	servers,
	servicePorts,
	serviceReplicas,
	services,
	serviceVolumes,
	workQueue,
} from "@/db/schema";
import { enqueueWork } from "@/lib/work-queue";
import {
	buildCurrentConfig,
	type HealthCheckConfig as ServiceHealthCheckConfig,
	type PortConfig,
} from "@/lib/service-config";
import { assignContainerIp } from "@/lib/wireguard";
import { slugify } from "@/lib/utils";
import { getEnvironment, getService } from "@/db/queries";
import { calculateSpreadPlacement } from "@/lib/placement";

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
		const { registry, namespace, repository, tag, digest } =
			parseImageReference(image);
		const reference = digest || tag || "latest";

		if (registry === "docker.io") {
			const repoPath =
				namespace === "library" ? repository : `${namespace}/${repository}`;

			if (digest) {
				const tokenUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${namespace === "library" ? "library/" : ""}${repoPath}:pull`;
				const tokenResponse = await fetch(tokenUrl);
				if (!tokenResponse.ok) {
					return {
						valid: false,
						error: "Failed to authenticate with Docker Hub",
					};
				}
				const tokenData = await tokenResponse.json();
				const token = tokenData.token;

				const manifestUrl = `https://registry-1.docker.io/v2/${namespace === "library" ? "library/" : ""}${repoPath}/manifests/${digest}`;
				const manifestResponse = await fetch(manifestUrl, {
					headers: {
						Authorization: `Bearer ${token}`,
						Accept:
							"application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
					},
				});

				if (manifestResponse.status === 404) {
					return {
						valid: false,
						error: "Image digest not found on Docker Hub",
					};
				}
				if (!manifestResponse.ok) {
					return { valid: false, error: "Failed to validate image" };
				}
				return { valid: true };
			}

			const url = `https://hub.docker.com/v2/repositories/${namespace === "library" ? "library/" : ""}${repoPath}/tags/${reference}`;
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
				return {
					valid: false,
					error: "Image not found on GitHub Container Registry",
				};
			}
			const tokenData = await tokenResponse.json();
			const token = tokenData.token;

			const manifestUrl = `https://ghcr.io/v2/${namespace}/${repository}/manifests/${reference}`;
			const manifestResponse = await fetch(manifestUrl, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept:
						"application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
				},
			});

			if (manifestResponse.status === 404) {
				return {
					valid: false,
					error: `Image ${digest ? "digest" : "tag"} not found on GitHub Container Registry`,
				};
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

	await db.transaction(async (tx) => {
		await tx.insert(projects).values({
			id,
			name,
			slug,
		});

		await tx.insert(environments).values({
			id: randomUUID(),
			projectId: id,
			name: "production",
		});
	});

	return { id, name, slug };
}

export async function deleteProject(id: string) {
	const projectServices = await db
		.select()
		.from(services)
		.where(eq(services.projectId, id));

	const activeStatuses = [
		"pending",
		"pulling",
		"starting",
		"healthy",
		"running",
		"stopping",
	];

	for (const service of projectServices) {
		const activeDeployments = await db
			.select()
			.from(deployments)
			.where(eq(deployments.serviceId, service.id));

		const hasActiveDeployments = activeDeployments.some((d) =>
			activeStatuses.includes(d.status),
		);

		if (hasActiveDeployments) {
			throw new Error(
				`Stop all services before deleting the project. Service "${service.name}" has active deployments.`,
			);
		}
	}

	await db.delete(projects).where(eq(projects.id, id));
	return { success: true };
}

export async function updateProjectName(projectId: string, name: string) {
	const trimmed = name.trim();
	if (!trimmed) {
		throw new Error("Project name cannot be empty");
	}

	await db
		.update(projects)
		.set({ name: trimmed })
		.where(eq(projects.id, projectId));

	return { success: true };
}

export async function updateProjectSlug(projectId: string, slug: string) {
	const sanitized = slugify(slug);
	if (!sanitized) {
		throw new Error("Invalid slug");
	}

	const existing = await db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.slug, sanitized));

	if (existing.some((p) => p.id !== projectId)) {
		throw new Error("This slug is already in use");
	}

	await db
		.update(projects)
		.set({ slug: sanitized })
		.where(eq(projects.id, projectId));

	return { success: true, slug: sanitized };
}

export async function createEnvironment(projectId: string, name: string) {
	const sanitizedName = slugify(name);
	if (!sanitizedName) {
		throw new Error("Invalid environment name");
	}

	const existing = await db
		.select()
		.from(environments)
		.where(
			and(
				eq(environments.projectId, projectId),
				eq(environments.name, sanitizedName),
			),
		);

	if (existing.length > 0) {
		throw new Error("Environment with this name already exists");
	}

	const id = randomUUID();
	await db.insert(environments).values({
		id,
		projectId,
		name: sanitizedName,
	});

	return { id, name: sanitizedName };
}

export async function deleteEnvironment(environmentId: string) {
	const env = await getEnvironment(environmentId);

	if (!env) {
		throw new Error("Environment not found");
	}

	if (env.name === "production") {
		throw new Error("Cannot delete the production environment");
	}

	await db.delete(environments).where(eq(environments.id, environmentId));
	return { success: true };
}

type CreateServiceInput = {
	projectId: string;
	environmentId: string;
	name: string;
	image: string;
	stateful?: boolean;
	github?: {
		repoUrl: string;
		branch: string;
		installationId?: number;
		repoId?: number;
	};
};

export async function createService(input: CreateServiceInput) {
	const {
		projectId,
		environmentId,
		name,
		image,
		stateful = false,
		github,
	} = input;
	const env = await getEnvironment(environmentId);

	if (!env) {
		throw new Error("Environment not found");
	}

	const id = randomUUID();
	const hostname = `${slugify(name)}-${env.name}`;

	let finalImage = image;
	let sourceType: "image" | "github" = "image";
	let githubRepoUrl: string | null = null;
	let githubBranch: string | null = null;

	if (github) {
		const registryHost = process.env.REGISTRY_HOST;
		if (!registryHost) {
			throw new Error("REGISTRY_HOST environment variable is required");
		}
		finalImage = `${registryHost}/${projectId}/${id}:latest`;
		sourceType = "github";
		githubRepoUrl = github.repoUrl;
		githubBranch = github.branch || "main";
	}

	await db.insert(services).values({
		id,
		projectId,
		environmentId,
		name,
		hostname,
		image: finalImage,
		sourceType,
		githubRepoUrl,
		githubBranch,
		replicas: 0,
		stateful,
	});

	if (github?.installationId && github?.repoId) {
		const repoFullName = github.repoUrl.replace("https://github.com/", "");
		await db.insert(githubRepos).values({
			id: randomUUID(),
			installationId: github.installationId,
			repoId: github.repoId,
			repoFullName,
			defaultBranch: github.branch || "main",
			serviceId: id,
			deployBranch: github.branch || "main",
			autoDeploy: true,
		});
	}

	return { id, name, image: finalImage, stateful, sourceType };
}

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
		"running",
		"stopping",
	];
	const hasActiveDeployments = activeDeployments.some((d) =>
		activeStatuses.includes(d.status),
	);

	if (hasActiveDeployments) {
		throw new Error("Stop all deployments before deleting the service");
	}

	if (service.stateful && service.lockedServerId) {
		const volumes = await db
			.select()
			.from(serviceVolumes)
			.where(eq(serviceVolumes.serviceId, serviceId));

		if (volumes.length > 0) {
			await enqueueWork(service.lockedServerId, "cleanup_volumes", {
				serviceId,
			});
		}
	}

	for (const deployment of activeDeployments) {
		await db
			.delete(deploymentPorts)
			.where(eq(deploymentPorts.deploymentId, deployment.id));
	}
	await db.delete(deployments).where(eq(deployments.serviceId, serviceId));
	await db.delete(secrets).where(eq(secrets.serviceId, serviceId));
	await db.delete(services).where(eq(services.id, serviceId));

	return { success: true };
}

export async function updateServiceHostname(
	serviceId: string,
	hostname: string,
) {
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

export async function updateServiceGithubRepo(
	serviceId: string,
	repoUrl: string | null,
	branch: string,
) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	let normalizedUrl: string | null = null;
	if (repoUrl) {
		normalizedUrl = repoUrl.trim();
		if (!normalizedUrl.startsWith("https://github.com/")) {
			throw new Error(
				"Repository URL must be a GitHub URL (https://github.com/...)",
			);
		}
	}

	const normalizedBranch = branch.trim() || "main";

	const updateData: Record<string, unknown> = {
		sourceType: normalizedUrl ? "github" : "image",
		githubRepoUrl: normalizedUrl,
		githubBranch: normalizedBranch,
	};

	if (normalizedUrl) {
		const registryHost = process.env.REGISTRY_HOST;
		if (!registryHost) {
			throw new Error("REGISTRY_HOST environment variable is required");
		}
		updateData.image = `${registryHost}/${service.projectId}/${serviceId}:latest`;
	}

	await db.update(services).set(updateData).where(eq(services.id, serviceId));

	return { success: true };
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

export async function deployService(serviceId: string) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	let placements: { serverId: string; replicas: number }[];

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
			.where(eq(serviceReplicas.serviceId, serviceId));

		for (const placement of calculatedPlacements) {
			await db.insert(serviceReplicas).values({
				id: randomUUID(),
				serviceId,
				serverId: placement.serverId,
				count: placement.count,
			});
		}

		placements = calculatedPlacements.map((p) => ({
			serverId: p.serverId,
			replicas: p.count,
		}));
	} else {
		const configuredReplicas = await db
			.select({
				serverId: serviceReplicas.serverId,
				replicas: serviceReplicas.count,
			})
			.from(serviceReplicas)
			.where(eq(serviceReplicas.serviceId, serviceId));

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
				throw new Error(
					"This stateful service is locked to its original server. Volume data cannot be moved between machines.",
				);
			}
		}
	}

	const serverIds = placements.map((p) => p.serverId);
	if (serverIds.length === 0) {
		throw new Error("No servers selected for deployment");
	}

	const totalReplicas = placements.reduce((sum, p) => sum + p.replicas, 0);

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
		throw new Error("A deployment is already in progress");
	}

	const rolloutId = randomUUID();

	await db.insert(rollouts).values({
		id: rolloutId,
		serviceId,
		status: "in_progress",
		currentStage: "deploying",
	});

	for (const dep of existingDeployments) {
		await db
			.delete(deploymentPorts)
			.where(eq(deploymentPorts.deploymentId, dep.id));
		await db.delete(deployments).where(eq(deployments.id, dep.id));
	}

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
		updateData.lockedServerId = serverIds[0];
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

	return { deploymentIds, replicaCount: totalReplicas, rolloutId };
}

export async function deleteDeployments(serviceId: string) {
	await db.delete(deployments).where(eq(deployments.serviceId, serviceId));
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
	config: HealthCheckConfig,
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
				await db
					.delete(deploymentPorts)
					.where(eq(deploymentPorts.servicePortId, portId));
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
		await db
			.delete(serviceReplicas)
			.where(eq(serviceReplicas.serviceId, serviceId));

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

export async function stopService(serviceId: string) {
	const runningDeployments = await db
		.select()
		.from(deployments)
		.where(
			and(
				eq(deployments.serviceId, serviceId),
				eq(deployments.status, "running"),
			),
		);

	for (const dep of runningDeployments) {
		if (!dep.containerId) continue;

		await db
			.update(deployments)
			.set({ status: "stopping" })
			.where(eq(deployments.id, dep.id));

		await enqueueWork(dep.serverId, "stop", {
			deploymentId: dep.id,
			containerId: dep.containerId,
		});
	}

	return { success: true, count: runningDeployments.length };
}

export async function restartService(serviceId: string) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	const runningDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const deploymentsToRestart = runningDeployments.filter(
		(d) => d.status === "running" && d.containerId,
	);

	if (deploymentsToRestart.length === 0) {
		throw new Error("No running containers to restart");
	}

	for (const dep of deploymentsToRestart) {
		await enqueueWork(dep.serverId, "restart", {
			deploymentId: dep.id,
			containerId: dep.containerId,
		});
	}

	return { success: true, count: deploymentsToRestart.length };
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
				.set({
					status: "failed",
					currentStage: "aborted",
					completedAt: new Date(),
				})
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
		await enqueueWork(serverId, "force_cleanup", {
			serviceId,
			containerIds,
		});
	}

	for (const dep of allDeployments) {
		await db
			.delete(deploymentPorts)
			.where(eq(deploymentPorts.deploymentId, dep.id));
	}

	await db.delete(deployments).where(eq(deployments.serviceId, serviceId));

	await db.delete(workQueue).where(eq(workQueue.status, "pending"));

	return { success: true };
}

export async function addServiceVolume(
	serviceId: string,
	name: string,
	containerPath: string,
) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	if (!service.stateful) {
		throw new Error("Volumes can only be added to stateful services");
	}

	const sanitizedName = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
	if (!sanitizedName || sanitizedName.length < 1) {
		throw new Error("Invalid volume name");
	}

	const trimmedPath = containerPath.trim();
	if (!trimmedPath.startsWith("/")) {
		throw new Error("Container path must be an absolute path");
	}

	const existing = await db
		.select()
		.from(serviceVolumes)
		.where(eq(serviceVolumes.serviceId, serviceId));

	if (existing.some((v) => v.name === sanitizedName)) {
		throw new Error("Volume with this name already exists");
	}

	if (existing.some((v) => v.containerPath === trimmedPath)) {
		throw new Error("A volume with this container path already exists");
	}

	const id = randomUUID();
	await db.insert(serviceVolumes).values({
		id,
		serviceId,
		name: sanitizedName,
		containerPath: trimmedPath,
	});

	return { id, name: sanitizedName, containerPath: trimmedPath };
}

export async function removeServiceVolume(volumeId: string) {
	const volume = await db
		.select()
		.from(serviceVolumes)
		.where(eq(serviceVolumes.id, volumeId));

	if (!volume[0]) {
		throw new Error("Volume not found");
	}

	const service = await getService(volume[0].serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	const activeDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, volume[0].serviceId));

	const runningStatuses = [
		"pending",
		"pulling",
		"starting",
		"healthy",
		"running",
	];
	const hasRunning = activeDeployments.some((d) =>
		runningStatuses.includes(d.status),
	);
	if (hasRunning) {
		throw new Error("Stop the service before removing volumes");
	}

	await db.delete(serviceVolumes).where(eq(serviceVolumes.id, volumeId));

	return { success: true };
}

export async function updateServiceAutoPlace(
	serviceId: string,
	autoPlace: boolean,
) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	if (service.stateful && autoPlace) {
		throw new Error("Stateful services cannot use auto-placement");
	}

	await db
		.update(services)
		.set({ autoPlace })
		.where(eq(services.id, serviceId));

	if (autoPlace) {
		await db
			.delete(serviceReplicas)
			.where(eq(serviceReplicas.serviceId, serviceId));
	}

	return { success: true };
}

export async function updateServiceReplicas(
	serviceId: string,
	replicas: number,
) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	if (replicas < 1 || replicas > 10) {
		throw new Error("Replicas must be between 1 and 10");
	}

	if (service.stateful && replicas > 1) {
		throw new Error("Stateful services can only have exactly 1 replica");
	}

	await db.update(services).set({ replicas }).where(eq(services.id, serviceId));

	return { success: true };
}
