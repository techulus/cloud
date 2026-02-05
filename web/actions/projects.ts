"use server";

import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import {
	nameSchema,
	replicaCountSchema,
	volumeNameSchema,
	containerPathSchema,
	githubRepoUrlSchema,
} from "@/lib/schemas";
import { getZodErrorMessage } from "@/lib/utils";
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
import { revalidatePath } from "next/cache";
import { enqueueWork } from "@/lib/work-queue";
import {
	type HealthCheckConfig as ServiceHealthCheckConfig,
	type PortConfig,
} from "@/lib/service-config";
import { slugify } from "@/lib/utils";
import { getEnvironment, getProject, getService } from "@/db/queries";
import { allocatePort } from "@/lib/port-allocation";
import cronstrue from "cronstrue";
import { startMigration } from "./migrations";
import { inngest } from "@/lib/inngest/client";

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

export async function createProject(name: string) {
	try {
		const validatedName = nameSchema.parse(name);
		const id = randomUUID();
		const slug = slugify(validatedName);

		await db.transaction(async (tx) => {
			await tx.insert(projects).values({
				id,
				name: validatedName,
				slug,
			});

			await tx.insert(environments).values({
				id: randomUUID(),
				projectId: id,
				name: "production",
			});
		});

		return { id, name: validatedName, slug };
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(getZodErrorMessage(error, "Invalid project name"));
		}
		throw error;
	}
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
	try {
		const validatedName = nameSchema.parse(name);

		await db
			.update(projects)
			.set({ name: validatedName })
			.where(eq(projects.id, projectId));

		return { success: true };
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(getZodErrorMessage(error, "Invalid project name"));
		}
		throw error;
	}
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
	github?: {
		repoUrl: string;
		branch: string;
		rootDir?: string;
		installationId?: number;
		repoId?: number;
	};
};

export async function createService(input: CreateServiceInput) {
	const { projectId, environmentId, name, image, github } = input;
	const env = await getEnvironment(environmentId);
	if (!env) {
		throw new Error("Environment not found");
	}

	const project = await getProject(projectId);
	if (!project) {
		throw new Error("Project not found");
	}

	const id = randomUUID();
	const hostname = `${project.slug}-${slugify(name)}-${env.name}`;

	let finalImage = image;
	let sourceType: "image" | "github" = "image";
	let githubRepoUrl: string | null = null;
	let githubBranch: string | null = null;
	let githubRootDir: string | null = null;

	if (github) {
		const registryHost = process.env.REGISTRY_HOST;
		if (!registryHost) {
			throw new Error("REGISTRY_HOST environment variable is required");
		}
		finalImage = `${registryHost}/${projectId}/${id}:latest`;
		sourceType = "github";
		githubRepoUrl = github.repoUrl;
		githubBranch = github.branch || "main";
		githubRootDir = github.rootDir?.trim() || null;
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
		githubRootDir,
		replicas: 1,
		stateful: false,
		autoPlace: true,
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

	return { id, name, image: finalImage, sourceType };
}

export async function deleteService(serviceId: string) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	const allDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	for (const dep of allDeployments) {
		if (dep.status === "running" && dep.containerId) {
			await db
				.update(deployments)
				.set({ status: "stopping" })
				.where(eq(deployments.id, dep.id));

			await enqueueWork(dep.serverId, "stop", {
				deploymentId: dep.id,
				containerId: dep.containerId,
			});
		}

		await db
			.delete(deploymentPorts)
			.where(eq(deploymentPorts.deploymentId, dep.id));
	}

	await db.delete(deployments).where(eq(deployments.serviceId, serviceId));

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
	rootDir?: string,
) {
	try {
		const service = await getService(serviceId);
		if (!service) {
			throw new Error("Service not found");
		}

		let normalizedUrl: string | null = null;
		if (repoUrl) {
			normalizedUrl = githubRepoUrlSchema.parse(repoUrl);
		}

		const normalizedBranch = branch.trim() || "main";
		const normalizedRootDir = rootDir?.trim() || null;

		const updateData: Record<string, unknown> = {
			sourceType: normalizedUrl ? "github" : "image",
			githubRepoUrl: normalizedUrl,
			githubBranch: normalizedBranch,
			githubRootDir: normalizedRootDir,
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
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(
				getZodErrorMessage(error, "Invalid GitHub repository URL"),
			);
		}
		throw error;
	}
}

export async function deployService(serviceId: string) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	if (service.stateful) {
		const configuredReplicas = await db
			.select({
				serverId: serviceReplicas.serverId,
				replicas: serviceReplicas.count,
			})
			.from(serviceReplicas)
			.where(eq(serviceReplicas.serviceId, serviceId));

		const placements = configuredReplicas.filter((p) => p.replicas > 0);
		const totalReplicas = placements.reduce((sum, p) => sum + p.replicas, 0);

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
			await startMigration(serviceId, targetServerId);
			revalidatePath(`/dashboard/projects`);
			return { migrationStarted: true };
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
		currentStage: "queued",
	});

	await inngest.send({
		name: "rollout/created",
		data: {
			rolloutId,
			serviceId,
		},
	});

	return { rolloutId };
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

export async function updateServiceStartCommand(
	serviceId: string,
	startCommand: string | null,
) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	await db
		.update(services)
		.set({ startCommand })
		.where(eq(services.id, serviceId));

	return { success: true };
}

const resourceLimitsSchema = z
	.object({
		cpuCores: z.number().min(0.1).max(64).nullable(),
		memoryMb: z.number().int().min(64).max(65536).nullable(),
	})
	.refine(
		(data) => {
			const hasCpu = data.cpuCores !== null;
			const hasMem = data.memoryMb !== null;
			return hasCpu === hasMem;
		},
		{
			message: "Both CPU and memory must be set together, or both must be null",
		},
	);

export async function updateServiceResourceLimits(
	serviceId: string,
	limits: { cpuCores: number | null; memoryMb: number | null },
) {
	const validated = resourceLimitsSchema.parse(limits);

	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	await db
		.update(services)
		.set({
			resourceCpuLimit: validated.cpuCores,
			resourceMemoryLimitMb: validated.memoryMb,
		})
		.where(eq(services.id, serviceId));

	return { success: true };
}

export async function updateServiceSchedule(
	serviceId: string,
	schedule: string | null,
) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	if (schedule) {
		try {
			cronstrue.toString(schedule);
		} catch {
			throw new Error("Invalid cron expression");
		}
	}

	await db
		.update(services)
		.set({ deploymentSchedule: schedule })
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
				const protocol = port.protocol || "http";

				if (
					existing.some((p) => p.port === port.port && p.protocol === protocol)
				) {
					throw new Error(`Port ${port.port} (${protocol}) already exists`);
				}

				if (port.isPublic) {
					if (protocol === "http") {
						if (!port.domain) {
							throw new Error("Domain is required for public HTTP ports");
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
							protocol: "http",
						});
					} else if (protocol === "tcp" || protocol === "udp") {
						const externalPort = await allocatePort(protocol);

						await db.insert(servicePorts).values({
							id: randomUUID(),
							serviceId,
							port: port.port,
							isPublic: true,
							protocol,
							externalPort,
							tlsPassthrough: port.tlsPassthrough ?? false,
						});
					}
				} else {
					await db.insert(servicePorts).values({
						id: randomUUID(),
						serviceId,
						port: port.port,
						isPublic: false,
						protocol,
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
	const updatedRollouts = await db
		.update(rollouts)
		.set({
			status: "failed",
			currentStage: "aborted",
			completedAt: new Date(),
		})
		.where(
			and(
				eq(rollouts.serviceId, serviceId),
				eq(rollouts.status, "in_progress"),
			),
		)
		.returning();

	const inProgressRollout = updatedRollouts[0];

	if (!inProgressRollout) {
		return { success: false, error: "No in-progress rollout found" };
	}

	await inngest.send({
		name: "rollout/cancelled",
		data: { rolloutId: inProgressRollout.id },
	});

	await db
		.update(deployments)
		.set({ status: "running" })
		.where(
			and(
				eq(deployments.serviceId, serviceId),
				eq(deployments.status, "draining"),
			),
		);

	const rolloutDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.rolloutId, inProgressRollout.id));

	const serverContainers = new Map<string, string[]>();

	for (const dep of rolloutDeployments) {
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

	for (const dep of rolloutDeployments) {
		await db
			.delete(deploymentPorts)
			.where(eq(deploymentPorts.deploymentId, dep.id));
	}

	await db
		.delete(deployments)
		.where(eq(deployments.rolloutId, inProgressRollout.id));

	await db.delete(workQueue).where(eq(workQueue.status, "pending"));

	return { success: true };
}

export async function addServiceVolume(
	serviceId: string,
	name: string,
	containerPath: string,
) {
	try {
		const validatedName = volumeNameSchema.parse(name);
		const validatedPath = containerPathSchema.parse(containerPath);

		const service = await getService(serviceId);
		if (!service) {
			throw new Error("Service not found");
		}

		let totalReplicas = service.replicas;
		if (!service.autoPlace) {
			const configuredReplicas = await db
				.select({ count: serviceReplicas.count })
				.from(serviceReplicas)
				.where(eq(serviceReplicas.serviceId, serviceId));
			totalReplicas = configuredReplicas.reduce((sum, r) => sum + r.count, 0);
		}

		if (totalReplicas > 1) {
			throw new Error(
				"Volumes can only be added to services with 1 replica. Reduce replicas to 1 first.",
			);
		}

		const existing = await db
			.select()
			.from(serviceVolumes)
			.where(eq(serviceVolumes.serviceId, serviceId));

		if (existing.some((v) => v.name === validatedName)) {
			throw new Error("Volume with this name already exists");
		}

		if (existing.some((v) => v.containerPath === validatedPath)) {
			throw new Error("A volume with this container path already exists");
		}

		const id = randomUUID();
		await db.insert(serviceVolumes).values({
			id,
			serviceId,
			name: validatedName,
			containerPath: validatedPath,
		});

		if (!service.stateful) {
			await db
				.update(services)
				.set({ stateful: true, autoPlace: false })
				.where(eq(services.id, serviceId));
		}

		return { id, name: validatedName, containerPath: validatedPath };
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(
				getZodErrorMessage(error, "Invalid volume configuration"),
			);
		}
		throw error;
	}
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

	const remainingVolumes = await db
		.select({ id: serviceVolumes.id })
		.from(serviceVolumes)
		.where(eq(serviceVolumes.serviceId, volume[0].serviceId));

	if (remainingVolumes.length === 0 && service.stateful) {
		await db
			.update(services)
			.set({ stateful: false, autoPlace: true })
			.where(eq(services.id, service.id));
	}

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
		throw new Error(
			"Services with volumes cannot use auto-placement. Remove volumes first.",
		);
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
	try {
		const validatedReplicas = replicaCountSchema.parse(replicas);

		const service = await getService(serviceId);
		if (!service) {
			throw new Error("Service not found");
		}

		if (service.stateful && validatedReplicas > 1) {
			throw new Error(
				"Services with volumes can only have 1 replica. Remove volumes first to scale up.",
			);
		}

		await db
			.update(services)
			.set({ replicas: validatedReplicas })
			.where(eq(services.id, serviceId));

		return { success: true };
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(getZodErrorMessage(error, "Invalid replica count"));
		}
		throw error;
	}
}

export async function updateServiceBackupSettings(
	serviceId: string,
	backupEnabled: boolean,
	backupSchedule: string | null,
) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	const volumes = await db
		.select({ id: serviceVolumes.id })
		.from(serviceVolumes)
		.where(eq(serviceVolumes.serviceId, serviceId));

	if (volumes.length === 0) {
		throw new Error(
			"Backup settings are only available for services with volumes",
		);
	}

	if (backupEnabled && !backupSchedule) {
		throw new Error("Schedule is required when backups are enabled");
	}

	await db
		.update(services)
		.set({
			backupEnabled,
			backupSchedule: backupEnabled ? backupSchedule : null,
		})
		.where(eq(services.id, serviceId));

	revalidatePath("/dashboard/projects");
	return { success: true };
}
