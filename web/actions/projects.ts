"use server";

import { randomUUID } from "node:crypto";
import cronstrue from "cronstrue";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { ZodError, z } from "zod";
import { db } from "@/db";
import {
	getBackupStorageConfig,
	getEnvironment,
	getProject,
	getService,
} from "@/db/queries";
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
	volumeBackups,
	workQueue,
} from "@/db/schema";
import { requireDeveloperRole } from "@/lib/auth";
import { DEFAULT_RESOURCE_LIMITS } from "@/lib/constants";
import { deployServiceInternal } from "@/lib/deploy-service";
import {
	isObservedReady,
	markDeploymentRemoved,
	runtimeExpectedStates,
} from "@/lib/deployment-status";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { restoreDrainingDeploymentsForRollback } from "@/lib/inngest/functions/rollout-utils";
import { allocatePort } from "@/lib/port-allocation";
import { blocksProjectDeletion } from "@/lib/project-deletion";
import {
	containerPathSchema,
	githubRepoUrlSchema,
	nameSchema,
	volumeNameSchema,
} from "@/lib/schemas";
import type {
	PortConfig,
	HealthCheckConfig as ServiceHealthCheckConfig,
} from "@/lib/service-config";
import { getZodErrorMessage, slugify } from "@/lib/utils";
import { enqueueWork } from "@/lib/work-queue";
import { deleteBackup } from "./backups";

function isValidImageReferencePart(reference: string): boolean {
	const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
	const digestPattern = /^[A-Za-z0-9_+.-]+:[0-9a-fA-F]{32,256}$/;

	return (
		reference === "latest" ||
		tagPattern.test(reference) ||
		digestPattern.test(reference)
	);
}

function isValidImageNamePart(part: string): boolean {
	const segmentPattern = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
	return part.split("/").every((segment) => segmentPattern.test(segment));
}

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
	await requireDeveloperRole();
	try {
		const { registry, namespace, repository, tag, digest } =
			parseImageReference(image);
		const reference = digest || tag || "latest";

		if (!isValidImageReferencePart(reference)) {
			return {
				valid: false,
				error: "Invalid image tag or digest",
			};
		}

		if (!isValidImageNamePart(namespace) || !isValidImageNamePart(repository)) {
			return {
				valid: false,
				error: "Invalid image name",
			};
		}

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
	await requireDeveloperRole();
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
	await requireDeveloperRole();
	const projectServices = await db
		.select()
		.from(services)
		.where(eq(services.projectId, id));

	for (const service of projectServices) {
		const activeDeployments = await db
			.select()
			.from(deployments)
			.where(eq(deployments.serviceId, service.id));

		const hasActiveDeployments = activeDeployments.some(blocksProjectDeletion);

		if (hasActiveDeployments) {
			throw new Error(
				`Stop all services before deleting the project. Service "${service.name}" has active deployments.`,
			);
		}
	}

	await deleteBackupsForServices(projectServices.map((service) => service.id));
	await db.delete(projects).where(eq(projects.id, id));
	return { success: true };
}

async function deleteBackupsForServices(serviceIds: string[]) {
	if (serviceIds.length === 0) {
		return;
	}

	const backups = await db
		.select({ id: volumeBackups.id })
		.from(volumeBackups)
		.where(inArray(volumeBackups.serviceId, serviceIds));

	for (const backup of backups) {
		await deleteBackup(backup.id, { revalidate: false });
	}
}

export async function updateProjectName(projectId: string, name: string) {
	await requireDeveloperRole();
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
	await requireDeveloperRole();
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
	await requireDeveloperRole();
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
	await requireDeveloperRole();
	const env = await getEnvironment(environmentId);

	if (!env) {
		throw new Error("Environment not found");
	}

	if (env.name === "production") {
		throw new Error("Cannot delete the production environment");
	}

	const envServices = await db
		.select({ id: services.id })
		.from(services)
		.where(eq(services.environmentId, environmentId));

	await deleteBackupsForServices(envServices.map((service) => service.id));
	await db.delete(environments).where(eq(environments.id, environmentId));
	return { success: true };
}

type CreateServiceInput = {
	projectId: string;
	environmentId: string;
	name: string;
	image: string;
	resourceLimits?: {
		cpuCores: number | null;
		memoryMb: number | null;
	};
	github?: {
		repoUrl: string;
		branch: string;
		rootDir?: string;
		installationId?: number;
		repoId?: number;
	};
};

const SERVICE_CANVAS_WIDTH = 1320;
const SERVICE_CARD_WIDTH = 320;

export async function createService(input: CreateServiceInput) {
	await requireDeveloperRole();
	const { projectId, environmentId, name, image, github } = input;
	const resourceLimits = input.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
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
	const newServiceCanvasPosition = {
		canvasX: (SERVICE_CANVAS_WIDTH - SERVICE_CARD_WIDTH) / 2,
		canvasY: 0,
	};

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

	const availableServers = await db
		.select({ id: servers.id })
		.from(servers)
		.where(and(eq(servers.status, "online"), isNotNull(servers.wireguardIp)));
	const selectedServer =
		availableServers.length > 0
			? availableServers[Math.floor(Math.random() * availableServers.length)]
			: null;

	await db.transaction(async (tx) => {
		await tx.insert(services).values({
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
			resourceCpuLimit: resourceLimits.cpuCores,
			resourceMemoryLimitMb: resourceLimits.memoryMb,
			canvasX: newServiceCanvasPosition.canvasX,
			canvasY: newServiceCanvasPosition.canvasY,
		});

		if (selectedServer) {
			await tx.insert(serviceReplicas).values({
				id: randomUUID(),
				serviceId: id,
				serverId: selectedServer.id,
				count: 1,
			});
		}

		if (github?.installationId && github?.repoId) {
			const repoFullName = github.repoUrl.replace("https://github.com/", "");
			await tx.insert(githubRepos).values({
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
	});

	return { id, name, image: finalImage, sourceType };
}

async function hardDeleteService(serviceId: string) {
	const service = await db
		.select()
		.from(services)
		.where(eq(services.id, serviceId))
		.then((r) => r[0]);
	if (!service) {
		throw new Error("Service not found");
	}

	const allDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	for (const dep of allDeployments) {
		if (isObservedReady(dep.observedPhase) && dep.containerId) {
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

	const backups = await db
		.select({ id: volumeBackups.id })
		.from(volumeBackups)
		.where(eq(volumeBackups.serviceId, serviceId));

	for (const backup of backups) {
		await deleteBackup(backup.id, { revalidate: false });
	}

	await db.delete(secrets).where(eq(secrets.serviceId, serviceId));
	await db.delete(services).where(eq(services.id, serviceId));

	return { success: true };
}

export async function deleteService(serviceId: string) {
	await requireDeveloperRole();
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	if (!service.stateful) {
		return hardDeleteService(serviceId);
	}

	const volumes = await db
		.select()
		.from(serviceVolumes)
		.where(eq(serviceVolumes.serviceId, serviceId));

	if (volumes.length === 0) {
		return hardDeleteService(serviceId);
	}

	const storageConfig = await getBackupStorageConfig();
	if (!storageConfig) {
		throw new Error(
			"Backup storage must be configured before deleting a stateful service",
		);
	}

	if (service.deletionStatus && service.deletionStatus !== "failed") {
		throw new Error("Deletion is already in progress for this service");
	}

	const runningDeployment = await db
		.select({
			id: deployments.id,
			serverId: deployments.serverId,
			containerId: deployments.containerId,
		})
		.from(deployments)
		.where(
			and(
				eq(deployments.serviceId, serviceId),
				inArray(deployments.observedPhase, ["running", "healthy"]),
			),
		)
		.then((r) => r[0]);

	const reusableBackupIds: string[] = [];

	if (!runningDeployment || !runningDeployment.containerId) {
		for (const volume of volumes) {
			const latestBackup = await db
				.select({ id: volumeBackups.id })
				.from(volumeBackups)
				.where(
					and(
						eq(volumeBackups.volumeId, volume.id),
						eq(volumeBackups.status, "completed"),
					),
				)
				.orderBy(desc(volumeBackups.createdAt))
				.limit(1)
				.then((r) => r[0]);

			if (!latestBackup) {
				throw new Error(
					"Stateful service must be running long enough to create a recoverable backup before deletion",
				);
			}

			await db
				.update(volumeBackups)
				.set({ isDeletionBackup: true })
				.where(eq(volumeBackups.id, latestBackup.id));
			reusableBackupIds.push(latestBackup.id);
		}
	}

	await db
		.update(services)
		.set({ deletionStatus: "backing_up", deletionError: null })
		.where(eq(services.id, serviceId));

	try {
		await inngest.send(
			inngestEvents.serviceDeletionStarted.create({
				serviceId,
				reusableBackupIds,
			}),
		);
	} catch (error) {
		await db
			.update(services)
			.set({
				deletionStatus: "failed",
				deletionError:
					error instanceof Error ? error.message : "Deletion workflow failed",
			})
			.where(eq(services.id, serviceId));
		throw error;
	}

	revalidatePath("/dashboard/projects");
	return { success: true, softDeleteStarted: true };
}

export async function restoreDeletedService(serviceId: string) {
	await requireDeveloperRole();
	const service = await db
		.select()
		.from(services)
		.where(eq(services.id, serviceId))
		.then((r) => r[0]);

	if (!service || !service.deletedAt) {
		throw new Error("Deleted service not found");
	}

	if (service.deletionStatus && service.deletionStatus !== "failed") {
		throw new Error("A deletion or restore operation is already in progress");
	}

	if (service.originalHostname) {
		const existingHostname = await db
			.select({ id: services.id })
			.from(services)
			.where(eq(services.hostname, service.originalHostname));

		if (existingHostname.some((s) => s.id !== serviceId)) {
			throw new Error(
				"Cannot restore because another service is using the original hostname",
			);
		}
	}

	const volumes = await db
		.select({ id: serviceVolumes.id })
		.from(serviceVolumes)
		.where(eq(serviceVolumes.serviceId, serviceId));

	const backupIds: string[] = [];
	for (const volume of volumes) {
		const backup = await db
			.select({ id: volumeBackups.id })
			.from(volumeBackups)
			.where(
				and(
					eq(volumeBackups.volumeId, volume.id),
					eq(volumeBackups.isDeletionBackup, true),
					eq(volumeBackups.status, "completed"),
				),
			)
			.orderBy(desc(volumeBackups.createdAt))
			.limit(1)
			.then((r) => r[0]);

		if (!backup) {
			throw new Error("Cannot restore because a retained backup is missing");
		}

		backupIds.push(backup.id);
	}

	let targetServerId: string | null = null;

	if (service.stateful) {
		const existingReplicas = await db
			.select({
				id: serviceReplicas.id,
				serverId: serviceReplicas.serverId,
				count: serviceReplicas.count,
				serverStatus: servers.status,
			})
			.from(serviceReplicas)
			.leftJoin(servers, eq(serviceReplicas.serverId, servers.id))
			.where(eq(serviceReplicas.serviceId, serviceId));

		const activeReplica = existingReplicas.find((r) => r.count > 0);

		if (activeReplica?.serverStatus === "online") {
			targetServerId = activeReplica.serverId;
		} else {
			throw new Error(
				"Cannot restore because the selected server is unavailable",
			);
		}
	}

	await db
		.update(services)
		.set({
			deletionStatus: "restoring",
			deletionError: null,
			lockedServerId: targetServerId ?? service.lockedServerId,
		})
		.where(eq(services.id, serviceId));

	try {
		await inngest.send(
			inngestEvents.serviceRestoreStarted.create({
				serviceId,
				targetServerId,
				backupIds,
			}),
		);
	} catch (error) {
		await db
			.update(services)
			.set({
				deletionStatus: "failed",
				deletionError:
					error instanceof Error ? error.message : "Restore workflow failed",
			})
			.where(eq(services.id, serviceId));
		throw error;
	}

	revalidatePath("/dashboard/projects");
	return { success: true };
}

export async function updateServiceHostname(
	serviceId: string,
	hostname: string,
) {
	await requireDeveloperRole();
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
	await requireDeveloperRole();
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
	await requireDeveloperRole();
	return deployServiceInternal(serviceId);
}

export async function deleteDeployments(serviceId: string) {
	await requireDeveloperRole();
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
	await requireDeveloperRole();
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
	await requireDeveloperRole();
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
	await requireDeveloperRole();
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
	await requireDeveloperRole();
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

const serverlessSettingsSchema = z.object({
	enabled: z.boolean(),
	sleepAfterSeconds: z.number().int().min(60).max(86_400),
	wakeTimeoutSeconds: z.number().int().min(10).max(900),
	minReadyReplicas: z.number().int().min(1).max(10),
});

export async function updateServiceServerlessSettings(
	serviceId: string,
	settings: {
		enabled: boolean;
		sleepAfterSeconds: number;
		wakeTimeoutSeconds: number;
		minReadyReplicas: number;
	},
) {
	await requireDeveloperRole();
	const validated = serverlessSettingsSchema.parse(settings);

	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);

		const [service] = await tx
			.select()
			.from(services)
			.where(eq(services.id, serviceId))
			.limit(1);

		if (!service || service.deletedAt) {
			throw new Error("Service not found");
		}

		if (validated.enabled) {
			const publicHttpPorts = await tx
				.select({ id: servicePorts.id })
				.from(servicePorts)
				.where(
					and(
						eq(servicePorts.serviceId, serviceId),
						eq(servicePorts.isPublic, true),
						eq(servicePorts.protocol, "http"),
						isNotNull(servicePorts.domain),
					),
				)
				.limit(1);

			if (publicHttpPorts.length === 0) {
				throw new Error(
					"Serverless services require a public HTTP port with a domain",
				);
			}

			const configuredReplicas = await tx
				.select({ count: serviceReplicas.count })
				.from(serviceReplicas)
				.where(eq(serviceReplicas.serviceId, serviceId));
			const totalConfiguredReplicas = configuredReplicas.reduce(
				(total, replica) => total + replica.count,
				0,
			);

			if (totalConfiguredReplicas < 1) {
				throw new Error("Serverless services require at least one replica");
			}
			if (validated.minReadyReplicas > totalConfiguredReplicas) {
				throw new Error(
					"Minimum ready replicas cannot exceed configured replicas",
				);
			}
		}

		await tx
			.update(services)
			.set({
				serverlessEnabled: validated.enabled,
				serverlessSleepAfterSeconds: validated.sleepAfterSeconds,
				serverlessWakeTimeoutSeconds: validated.wakeTimeoutSeconds,
				serverlessMinReadyReplicas: validated.minReadyReplicas,
			})
			.where(eq(services.id, serviceId));

	});

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
	await requireDeveloperRole();
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

		let totalReplicas = 0;
		for (const replica of config.replicas) {
			if (replica.count > 0) {
				totalReplicas += replica.count;
				await db.insert(serviceReplicas).values({
					id: randomUUID(),
					serviceId,
					serverId: replica.serverId,
					count: replica.count,
				});
			}
		}

		await db
			.update(services)
			.set({
				serverlessMinReadyReplicas: sql`LEAST(${services.serverlessMinReadyReplicas}, ${Math.max(1, totalReplicas)})`,
			})
			.where(
				and(eq(services.id, serviceId), eq(services.serverlessEnabled, true)),
			);
	}

	return { success: true };
}

export async function stopService(serviceId: string) {
	await requireDeveloperRole();
	const desiredDeployments = await db
		.select()
		.from(deployments)
		.where(
			and(
				eq(deployments.serviceId, serviceId),
				inArray(deployments.runtimeDesiredState, runtimeExpectedStates),
			),
		);

	for (const dep of desiredDeployments) {
		await db
			.update(deployments)
			.set(markDeploymentRemoved())
			.where(eq(deployments.id, dep.id));

		if (!dep.containerId) continue;
		await enqueueWork(dep.serverId, "stop", {
			deploymentId: dep.id,
			containerId: dep.containerId,
		});
	}

	return { success: true, count: desiredDeployments.length };
}

export async function restartService(serviceId: string) {
	await requireDeveloperRole();
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	const runningDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const deploymentsToRestart = runningDeployments.filter(
		(d) => isObservedReady(d.observedPhase) && d.containerId,
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
	await requireDeveloperRole();
	const activeRollouts = await db
		.select({ id: rollouts.id, status: rollouts.status })
		.from(rollouts)
		.where(
			and(
				eq(rollouts.serviceId, serviceId),
				inArray(rollouts.status, ["queued", "in_progress"]),
			),
		);

	if (activeRollouts.length === 0) {
		return { success: false, error: "No in-progress rollout found" };
	}

	const activeRolloutIds = activeRollouts.map((rollout) => rollout.id);

	await db
		.update(rollouts)
		.set({
			status: "failed",
			currentStage: "aborted",
			completedAt: new Date(),
		})
		.where(inArray(rollouts.id, activeRolloutIds));

	for (const rolloutId of activeRolloutIds) {
		await inngest.send(
			inngestEvents.rolloutCancelled.create({
				rolloutId,
			}),
		);
	}

	await restoreDrainingDeploymentsForRollback(serviceId);

	const rolloutDeployments =
		activeRolloutIds.length > 0
			? await db
					.select()
					.from(deployments)
					.where(inArray(deployments.rolloutId, activeRolloutIds))
			: [];

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

	if (activeRolloutIds.length > 0) {
		await db
			.delete(deployments)
			.where(inArray(deployments.rolloutId, activeRolloutIds));
	}

	const pendingWork =
		serverContainers.size > 0
			? await db
					.select({ id: workQueue.id, payload: workQueue.payload })
					.from(workQueue)
					.where(
						and(
							eq(workQueue.status, "pending"),
							inArray(workQueue.type, ["deploy", "reconcile"]),
							inArray(workQueue.serverId, [...serverContainers.keys()]),
						),
					)
			: [];

	const rolloutDeploymentIds = new Set(rolloutDeployments.map((d) => d.id));
	const workToDelete = pendingWork.filter((w) => {
		try {
			const parsed = JSON.parse(w.payload);
			return rolloutDeploymentIds.has(parsed.deploymentId);
		} catch {
			return false;
		}
	});

	if (workToDelete.length > 0) {
		await db.delete(workQueue).where(
			inArray(
				workQueue.id,
				workToDelete.map((w) => w.id),
			),
		);
	}

	return { success: true };
}

export async function addServiceVolume(
	serviceId: string,
	name: string,
	containerPath: string,
) {
	await requireDeveloperRole();
	try {
		const validatedName = volumeNameSchema.parse(name);
		const validatedPath = containerPathSchema.parse(containerPath);

		const service = await getService(serviceId);
		if (!service) {
			throw new Error("Service not found");
		}

		const configuredReplicas = await db
			.select({ count: serviceReplicas.count })
			.from(serviceReplicas)
			.where(eq(serviceReplicas.serviceId, serviceId));
		const totalReplicas = configuredReplicas.reduce(
			(sum, r) => sum + r.count,
			0,
		);

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
				.set({ stateful: true })
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
	await requireDeveloperRole();
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

	const hasRunning = activeDeployments.some(blocksProjectDeletion);
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
			.set({ stateful: false })
			.where(eq(services.id, service.id));
	}

	return { success: true };
}

export async function updateServiceBackupSettings(
	serviceId: string,
	backupEnabled: boolean,
	backupSchedule: string | null,
) {
	await requireDeveloperRole();
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
