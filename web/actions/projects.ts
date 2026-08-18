"use server";

import { randomUUID } from "node:crypto";
import cronstrue from "cronstrue";
import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";
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
} from "@/db/schema";
import { requireDeveloperRole, verifyDeleteConfirmation } from "@/lib/auth";
import { deployServiceInternal } from "@/lib/deploy-service";
import {
	isObservedReady,
	isRuntimeExpected,
	markDeploymentRemoved,
	observedReadyPhases,
	runtimeExpectedStates,
} from "@/lib/deployment-status";
import { validateDockerImageInternal } from "@/lib/docker-image";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { allocatePort } from "@/lib/port-allocation";
import { resolveRegistryImageHost } from "@/lib/registry-reference";
import {
	cleanupRegistryArtifactsForService,
	prepareRegistryArtifactCleanup,
} from "@/lib/registry-retention";
import {
	deletePreviewService,
	deletePreviewsForBaseService,
} from "@/lib/preview-lifecycle";
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
import { MIN_SERVERLESS_SLEEP_AFTER_SECONDS } from "@/lib/service-config";
import {
	findServicePortValidationIssue,
	getDefaultServiceHostname,
} from "@/lib/service-revision-spec";
import type { DeleteConfirmation } from "@/lib/two-factor";
import { getZodErrorMessage, slugify } from "@/lib/utils";
import {
	enqueueReconcileForAllOnlineServers,
	enqueueWork,
} from "@/lib/work-queue";
import { deleteBackup } from "./backups";

export async function validateDockerImage(
	image: string,
): Promise<{ valid: boolean; error?: string }> {
	await requireDeveloperRole();
	return validateDockerImageInternal(image);
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

export async function deleteProject(
	id: string,
	confirmation?: DeleteConfirmation,
) {
	const session = await requireDeveloperRole();
	await verifyDeleteConfirmation(session, confirmation, "project");
	const projectServices = await db
		.select()
		.from(services)
		.where(eq(services.projectId, id));

	for (const service of projectServices) {
		const activeDeployments = await db
			.select()
			.from(deployments)
			.where(eq(deployments.serviceId, service.id));

		// "stopped" can be a sleeping, wakeable serverless deployment.
		const hasActiveDeployments = activeDeployments.some(
			({ runtimeDesiredState }) => isRuntimeExpected(runtimeDesiredState),
		);

		if (hasActiveDeployments) {
			throw new Error(
				`Stop all services before deleting the project. Service "${service.name}" has active deployments.`,
			);
		}
	}

	for (const service of projectServices.sort(
		(a, b) =>
			Number(Boolean(b.previewOfService)) - Number(Boolean(a.previewOfService)),
	)) {
		await hardDeleteService(service.id);
	}
	await db.transaction(async (tx) => {
		const locked = await tx.execute(
			sql`select id from projects where id = ${id} for update`,
		);
		if (locked.rows.length === 0) throw new Error("Project not found");
		const remainingServices = await tx
			.select({ id: services.id })
			.from(services)
			.where(eq(services.projectId, id))
			.limit(1);
		if (remainingServices.length > 0) {
			throw new Error(
				"Project services changed during deletion; retry deletion",
			);
		}
		await tx.delete(projects).where(eq(projects.id, id));
	});
	return { success: true };
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
		.select({ id: services.id, previewOfService: services.previewOfService })
		.from(services)
		.where(eq(services.environmentId, environmentId));

	for (const service of envServices.sort(
		(a, b) =>
			Number(Boolean(b.previewOfService)) - Number(Boolean(a.previewOfService)),
	)) {
		await hardDeleteService(service.id);
	}
	await db.transaction(async (tx) => {
		const locked = await tx.execute(
			sql`select id from environments where id = ${environmentId} for update`,
		);
		if (locked.rows.length === 0) throw new Error("Environment not found");
		const remainingServices = await tx
			.select({ id: services.id })
			.from(services)
			.where(eq(services.environmentId, environmentId))
			.limit(1);
		if (remainingServices.length > 0) {
			throw new Error(
				"Environment services changed during deletion; retry deletion",
			);
		}
		await tx.delete(environments).where(eq(environments.id, environmentId));
	});
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
	if (!github) {
		const validation = await validateDockerImageInternal(image);
		if (!validation.valid) {
			throw new Error(validation.error ?? "Invalid image reference");
		}
	}
	const resourceLimits = input.resourceLimits ?? {
		cpuCores: null,
		memoryMb: null,
	};
	const env = await getEnvironment(environmentId);
	if (!env) {
		throw new Error("Environment not found");
	}

	const project = await getProject(projectId);
	if (!project) {
		throw new Error("Project not found");
	}

	const id = randomUUID();
	const hostname = getDefaultServiceHostname(
		`${project.slug}-${name}-${env.name}`,
		id,
	);
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
		const registryHost = resolveRegistryImageHost();
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
	const preview = await db
		.select({
			previewOfService: services.previewOfService,
			previewGitRef: services.previewGitRef,
		})
		.from(services)
		.where(eq(services.id, serviceId))
		.then((rows) => rows[0]);
	if (preview?.previewOfService && preview.previewGitRef) {
		const deleted = await deletePreviewService(
			preview.previewOfService,
			preview.previewGitRef,
		);
		if (!deleted) throw new Error("Preview service not found");
		return { success: true };
	}

	const service = await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${serviceId}))`);
		const freshService = await tx
			.select()
			.from(services)
			.where(
				and(
					eq(services.id, serviceId),
					or(
						isNull(services.deletionStatus),
						eq(services.deletionStatus, "failed"),
					),
				),
			)
			.then((rows) => rows[0]);
		if (!freshService) return undefined;
		const now = new Date();
		const claimed = await tx
			.update(services)
			.set({
				deletedAt: now,
				purgeAfter: now,
				deletionStatus: "deleting",
				deletionError: null,
			})
			.where(eq(services.id, serviceId))
			.returning()
			.then((rows) => rows[0]);
		if (!claimed) return undefined;
		return {
			service: claimed,
			registryCleanupReady: await prepareRegistryArtifactCleanup(tx, serviceId),
		};
	});
	if (!service) {
		throw new Error(
			"Service not found or another service operation is in progress",
		);
	}
	if (!service.registryCleanupReady) {
		throw new Error(
			"Service deletion deferred while registry manifest work is processing",
		);
	}
	const claimedService = service.service;
	await deletePreviewsForBaseService(serviceId, "base service deleted");

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

	if (claimedService.stateful && claimedService.lockedServerId) {
		const volumes = await db
			.select()
			.from(serviceVolumes)
			.where(eq(serviceVolumes.serviceId, serviceId));

		if (volumes.length > 0) {
			await enqueueWork(claimedService.lockedServerId, "cleanup_volumes", {
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

	await cleanupRegistryArtifactsForService(serviceId);
	await db.delete(secrets).where(eq(secrets.serviceId, serviceId));
	await db.delete(services).where(eq(services.id, serviceId));

	return { success: true };
}

export async function deleteService(
	serviceId: string,
	confirmation?: DeleteConfirmation,
) {
	const session = await requireDeveloperRole();
	await verifyDeleteConfirmation(session, confirmation, "service");

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
				inArray(deployments.observedPhase, observedReadyPhases),
			),
		)
		.then((r) => r[0]);

	const reusableBackupIds: string[] = [];

	if (!runningDeployment || !runningDeployment.containerId) {
		const latestBackupIds: string[] = [];
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

			if (latestBackup) latestBackupIds.push(latestBackup.id);
		}

		if (latestBackupIds.length === volumes.length) {
			await db
				.update(volumeBackups)
				.set({ isDeletionBackup: true })
				.where(inArray(volumeBackups.id, latestBackupIds));
			reusableBackupIds.push(...latestBackupIds);
		} else if (!service.lockedServerId) {
			throw new Error(
				"Stateful service must have a locked server or completed backups before deletion",
			);
		}
	}

	const claimed = await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${serviceId}))`);
		return tx
			.update(services)
			.set({ deletionStatus: "backing_up", deletionError: null })
			.where(
				and(
					eq(services.id, serviceId),
					isNull(services.deletedAt),
					or(
						isNull(services.deletionStatus),
						eq(services.deletionStatus, "failed"),
					),
				),
			)
			.returning({ id: services.id })
			.then((rows) => rows[0]);
	});
	if (!claimed) {
		throw new Error(
			"Deletion cannot start while another service operation is in progress",
		);
	}

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
	const session = await requireDeveloperRole();
	if (!session) throw new Error("Unauthorized");
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

	await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${serviceId}))`);
		const current = await tx
			.select({ id: services.id })
			.from(services)
			.where(
				and(
					eq(services.id, serviceId),
					isNotNull(services.deletedAt),
					or(
						isNull(services.deletionStatus),
						eq(services.deletionStatus, "failed"),
					),
				),
			)
			.limit(1)
			.then((rows) => rows[0]);
		if (!current) {
			throw new Error("A deletion or restore operation is already in progress");
		}
		await tx
			.update(services)
			.set({
				deletionStatus: "restoring",
				deletionError: null,
				lockedServerId: targetServerId ?? service.lockedServerId,
			})
			.where(eq(services.id, serviceId));
	});

	try {
		await inngest.send(
			inngestEvents.serviceRestoreStarted.create({
				serviceId,
				targetServerId,
				backupIds,
				actor: {
					type: "user",
					userId: session.user.id,
					name: session.user.name,
				},
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
	if (!sanitized || sanitized.length > 63) {
		throw new Error(
			"Hostname must be a valid DNS label of at most 63 characters",
		);
	}

	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);
		const current = await tx
			.select({ id: services.id })
			.from(services)
			.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
			.limit(1)
			.then((rows) => rows[0]);
		if (!current) throw new Error("Service not found");
		const existing = await tx
			.select({ id: services.id })
			.from(services)
			.where(eq(services.hostname, sanitized));

		if (existing.some((s) => s.id !== serviceId)) {
			throw new Error("Hostname is already in use");
		}

		await tx
			.update(services)
			.set({ hostname: sanitized })
			.where(and(eq(services.id, serviceId), isNull(services.deletedAt)));
	});

	return { success: true, hostname: sanitized };
}

export async function updateServiceName(serviceId: string, name: string) {
	await requireDeveloperRole();
	try {
		const validatedName = nameSchema.parse(name);

		await db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`,
			);
			const current = await tx
				.select({ name: services.name, hostname: services.hostname })
				.from(services)
				.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
				.limit(1)
				.then((rows) => rows[0]);
			if (!current) throw new Error("Service not found");
			await tx
				.update(services)
				.set({
					name: validatedName,
					hostname:
						current.hostname ??
						getDefaultServiceHostname(current.name, serviceId),
				})
				.where(and(eq(services.id, serviceId), isNull(services.deletedAt)));
		});

		return { success: true, name: validatedName };
	} catch (error) {
		if (error instanceof ZodError) {
			throw new Error(getZodErrorMessage(error, "Invalid service name"));
		}
		throw error;
	}
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
			const registryHost = resolveRegistryImageHost();
			updateData.image = `${registryHost}/${service.projectId}/${serviceId}:latest`;
		}

		let reconcilePreviews = false;
		await db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`,
			);
			const current = await tx
				.select({
					githubRepoUrl: services.githubRepoUrl,
					previewDeploymentsEnabled: services.previewDeploymentsEnabled,
					previewOfService: services.previewOfService,
				})
				.from(services)
				.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
				.then((rows) => rows[0]);
			if (!current) throw new Error("Service not found");
			if (current.previewOfService && normalizedUrl !== current.githubRepoUrl) {
				throw new Error(
					"A preview service must remain linked to its pull request",
				);
			}
			if (
				current.previewDeploymentsEnabled &&
				!current.previewOfService &&
				normalizedUrl !== current.githubRepoUrl
			) {
				throw new Error(
					"Disable preview deployments before changing the GitHub repository",
				);
			}
			reconcilePreviews =
				current.previewDeploymentsEnabled && !current.previewOfService;
			await tx
				.update(services)
				.set(updateData)
				.where(eq(services.id, serviceId));
			await tx
				.update(githubRepos)
				.set({ deployBranch: normalizedBranch })
				.where(eq(githubRepos.serviceId, serviceId));
		});
		if (reconcilePreviews) {
			await inngest.send(
				inngestEvents.previewServiceReconcileRequested.create(
					{ baseServiceId: serviceId },
					{ id: `preview-source:${serviceId}:${randomUUID()}` },
				),
			);
		}

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
	const session = await requireDeveloperRole();
	if (!session) throw new Error("Unauthorized");
	const actor = {
		type: "user",
		userId: session.user.id,
		name: session.user.name,
	} as const;
	return deployServiceInternal(serviceId, actor, { githubTrigger: "manual" });
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

	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);
		await tx
			.update(services)
			.set({
				healthCheckCmd: config.cmd,
				healthCheckInterval: config.interval,
				healthCheckTimeout: config.timeout,
				healthCheckRetries: config.retries,
				healthCheckStartPeriod: config.startPeriod,
			})
			.where(eq(services.id, serviceId));
	});

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

	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);
		await tx
			.update(services)
			.set({ startCommand })
			.where(eq(services.id, serviceId));
	});

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
	if (
		service.autoscalingEnabled &&
		(validated.cpuCores === null || validated.memoryMb === null)
	) {
		throw new Error("Disable autoscaling before removing resource limits");
	}

	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);
		await tx
			.update(services)
			.set({
				resourceCpuLimit: validated.cpuCores,
				resourceMemoryLimitMb: validated.memoryMb,
			})
			.where(eq(services.id, serviceId));
	});

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
	sleepAfterSeconds: z
		.number()
		.int()
		.min(MIN_SERVERLESS_SLEEP_AFTER_SECONDS)
		.max(86_400),
	wakeTimeoutSeconds: z.number().int().min(10).max(900),
});

export async function updateServiceServerlessSettings(
	serviceId: string,
	settings: {
		enabled: boolean;
		sleepAfterSeconds: number;
		wakeTimeoutSeconds: number;
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
			if (service.autoscalingEnabled) {
				throw new Error("Disable autoscaling before enabling serverless");
			}
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

			const [configuredReplicas, volume] = await Promise.all([
				tx
					.select({
						count: serviceReplicas.count,
						serverIsProxy: servers.isProxy,
					})
					.from(serviceReplicas)
					.innerJoin(servers, eq(serviceReplicas.serverId, servers.id))
					.where(eq(serviceReplicas.serviceId, serviceId)),
				tx
					.select({ id: serviceVolumes.id })
					.from(serviceVolumes)
					.where(eq(serviceVolumes.serviceId, serviceId))
					.limit(1),
			]);
			if (
				service.placementMode === "automatic" &&
				(service.stateful || volume.length > 0)
			) {
				throw new Error(
					"Automatic placement is not supported for stateful services or services with volumes",
				);
			}
			const totalConfiguredReplicas =
				service.placementMode === "automatic"
					? service.replicas
					: configuredReplicas.reduce(
							(total, replica) => total + replica.count,
							0,
						);

			if (totalConfiguredReplicas < 1) {
				throw new Error("Serverless services require at least one replica");
			}

			if (
				service.placementMode === "manual" &&
				configuredReplicas.some(
					(replica) => replica.count > 0 && !replica.serverIsProxy,
				)
			) {
				throw new Error(
					"Serverless services can only be deployed to proxy nodes",
				);
			}
		}

		await tx
			.update(services)
			.set({
				serverlessEnabled: validated.enabled,
				serverlessSleepAfterSeconds: validated.sleepAfterSeconds,
				serverlessWakeTimeoutSeconds: validated.wakeTimeoutSeconds,
			})
			.where(eq(services.id, serviceId));
	});

	return { success: true };
}

export type ServiceConfigUpdate = {
	source?: { type: "image"; image: string };
	healthCheck?: ServiceHealthCheckConfig | null;
	ports?: { add?: PortConfig[]; remove?: string[] };
	placement?:
		| { mode: "automatic"; replicas: number }
		| {
				mode: "automatic";
				autoscaling: { minReplicas: number; maxReplicas: number };
		  }
		| {
				mode: "manual";
				placements: { serverId: string; count: number }[];
		  };
};

const autoscalingRangeSchema = z
	.strictObject({
		minReplicas: z.number().int().min(1).max(32),
		maxReplicas: z.number().int().min(1).max(32),
	})
	.refine((value) => value.minReplicas <= value.maxReplicas, {
		message: "Minimum replicas cannot exceed maximum replicas",
		path: ["minReplicas"],
	});

const placementInputSchema = z.union([
	z.strictObject({
		mode: z.literal("automatic"),
		replicas: z.number().int().min(1).max(32),
	}),
	z.strictObject({
		mode: z.literal("automatic"),
		autoscaling: autoscalingRangeSchema,
	}),
	z
		.strictObject({
			mode: z.literal("manual"),
			placements: z
				.array(
					z.strictObject({
						serverId: z.string().min(1),
						count: z.number().int().min(1).max(32),
					}),
				)
				.min(1),
		})
		.superRefine((value, context) => {
			if (
				new Set(value.placements.map((item) => item.serverId)).size !==
				value.placements.length
			)
				context.addIssue({
					code: "custom",
					message: "Server IDs must be unique",
					path: ["placements"],
				});
			const total = value.placements.reduce((sum, item) => sum + item.count, 0);
			if (total > 32)
				context.addIssue({
					code: "custom",
					message: "Total replicas must be between 1 and 32",
					path: ["placements"],
				});
		}),
]);

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
		const validation = await validateDockerImageInternal(config.source.image);
		if (!validation.valid) {
			throw new Error(validation.error ?? "Invalid image reference");
		}
	}

	if (config.source || config.healthCheck !== undefined) {
		await db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`,
			);
			if (config.source) {
				await tx
					.update(services)
					.set({ image: config.source.image })
					.where(eq(services.id, serviceId));
			}

			if (config.healthCheck === null) {
				await tx
					.update(services)
					.set({
						healthCheckCmd: null,
						healthCheckInterval: null,
						healthCheckTimeout: null,
						healthCheckRetries: null,
						healthCheckStartPeriod: null,
					})
					.where(eq(services.id, serviceId));
			} else if (config.healthCheck !== undefined) {
				await tx
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
		});
	}

	if (config.ports) {
		try {
			await db.transaction(async (tx) => {
				await tx.execute(
					sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`,
				);
				const existing = await tx
					.select()
					.from(servicePorts)
					.where(eq(servicePorts.serviceId, serviceId));
				const removedIds = new Set(config.ports?.remove ?? []);
				if (
					[...removedIds].some((id) => !existing.some((port) => port.id === id))
				) {
					throw new Error("Port not found");
				}

				const additions: (typeof servicePorts.$inferInsert)[] = [];
				const reservedExternalPorts = {
					tcp: new Set<number>(),
					udp: new Set<number>(),
				};
				if (
					(config.ports?.add ?? []).some(
						(port) =>
							port.isPublic &&
							(port.protocol === "tcp" || port.protocol === "udp"),
					)
				) {
					await tx.execute(
						sql`SELECT pg_advisory_xact_lock(hashtext('service_port_external_allocation'))`,
					);
				}
				for (const port of config.ports?.add ?? []) {
					const protocol = port.protocol ?? "http";
					const domain = port.domain?.trim().toLowerCase() || null;
					const externalPort =
						port.isPublic && (protocol === "tcp" || protocol === "udp")
							? await allocatePort(
									tx,
									protocol,
									reservedExternalPorts[protocol],
								)
							: null;
					if (
						externalPort !== null &&
						(protocol === "tcp" || protocol === "udp")
					) {
						reservedExternalPorts[protocol].add(externalPort);
					}
					additions.push({
						id: randomUUID(),
						serviceId,
						port: port.port,
						isPublic: port.isPublic,
						domain: protocol === "http" && port.isPublic ? domain : null,
						protocol,
						externalPort,
						tlsPassthrough:
							protocol === "tcp" ? (port.tlsPassthrough ?? false) : false,
					});
				}

				const finalPorts = [
					...existing.filter((port) => !removedIds.has(port.id)),
					...additions,
				];
				const issue = findServicePortValidationIssue(
					finalPorts.map((port) => ({
						containerPort: port.port,
						isPublic: port.isPublic ?? false,
						domain: port.domain ?? null,
						protocol: port.protocol ?? "http",
					})),
				);
				if (issue) throw new Error(issue.message);
				if (
					!finalPorts.some(
						(port) =>
							port.isPublic && port.protocol === "http" && port.domain !== null,
					)
				) {
					await tx
						.update(services)
						.set({ serverlessEnabled: false })
						.where(eq(services.id, serviceId));
				}

				for (const port of additions) {
					if (!port.domain) continue;
					const conflict = await tx
						.select({ serviceId: servicePorts.serviceId })
						.from(servicePorts)
						.where(eq(servicePorts.domain, port.domain))
						.limit(1)
						.then((rows) => rows[0]);
					if (conflict && conflict.serviceId !== serviceId) {
						throw new Error("Domain already in use");
					}
				}

				if (removedIds.size > 0) {
					await tx
						.delete(servicePorts)
						.where(
							and(
								eq(servicePorts.serviceId, serviceId),
								inArray(servicePorts.id, [...removedIds]),
							),
						);
				}
				if (additions.length > 0) {
					await tx.insert(servicePorts).values(additions);
				}
			});
		} catch (error) {
			if (
				(error as { code?: string; constraint?: string }).code === "23505" &&
				(error as { constraint?: string }).constraint ===
					"service_ports_domain_unique"
			) {
				throw new Error("Domain already in use");
			}
			throw error;
		}
	}

	if (config.placement) {
		const placement = placementInputSchema.parse(config.placement);
		await db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`,
			);

			const [currentService] = await tx
				.select({
					serverlessEnabled: services.serverlessEnabled,
					stateful: services.stateful,
					placementMode: services.placementMode,
					resourceCpuLimit: services.resourceCpuLimit,
					resourceMemoryLimitMb: services.resourceMemoryLimitMb,
				})
				.from(services)
				.where(eq(services.id, serviceId))
				.limit(1);

			if (!currentService) throw new Error("Service not found");
			if (placement.mode === "automatic") {
				const volume = await tx
					.select({ id: serviceVolumes.id })
					.from(serviceVolumes)
					.where(eq(serviceVolumes.serviceId, serviceId))
					.limit(1);
				if (currentService.stateful || volume.length > 0)
					throw new Error(
						"Automatic placement is not supported for stateful services or services with volumes",
					);
				if ("autoscaling" in placement) {
					if (currentService.serverlessEnabled)
						throw new Error("Disable serverless before enabling autoscaling");
					if (
						currentService.resourceCpuLimit === null ||
						currentService.resourceMemoryLimitMb === null
					)
						throw new Error(
							"Set both CPU and memory limits before enabling autoscaling",
						);
				}
				const replicas =
					"autoscaling" in placement
						? Math.min(
								placement.autoscaling.maxReplicas,
								Math.max(placement.autoscaling.minReplicas, service.replicas),
							)
						: placement.replicas;
				await tx
					.update(services)
					.set({
						placementMode: "automatic",
						replicas,
						autoscalingEnabled: "autoscaling" in placement,
						autoscalingMinReplicas:
							"autoscaling" in placement
								? placement.autoscaling.minReplicas
								: replicas,
						autoscalingMaxReplicas:
							"autoscaling" in placement
								? placement.autoscaling.maxReplicas
								: replicas,
					})
					.where(eq(services.id, serviceId));
				await tx
					.delete(serviceReplicas)
					.where(eq(serviceReplicas.serviceId, serviceId));
				return;
			}

			const replicas = placement.placements;
			const selectedServerIds = replicas.map((replica) => replica.serverId);
			const selectedServers = await tx
				.select({
					id: servers.id,
					isProxy: servers.isProxy,
					status: servers.status,
					wireguardIp: servers.wireguardIp,
				})
				.from(servers)
				.where(inArray(servers.id, selectedServerIds));
			if (selectedServers.length !== selectedServerIds.length)
				throw new Error("One or more selected servers do not exist");
			if (
				selectedServers.some(
					(server) => server.status !== "online" || !server.wireguardIp,
				)
			)
				throw new Error("Manual placement requires online, configured servers");
			if (currentService.serverlessEnabled) {
				if (selectedServerIds.length > 0) {
					const workerServers = selectedServers.filter(
						(server) => !server.isProxy,
					);
					if (workerServers.length > 0) {
						throw new Error(
							"Disable serverless before deploying to worker nodes",
						);
					}
				}
			}

			await tx
				.update(services)
				.set({
					placementMode: "manual",
					replicas: replicas.reduce((sum, replica) => sum + replica.count, 0),
					autoscalingEnabled: false,
				})
				.where(eq(services.id, serviceId));
			await tx
				.delete(serviceReplicas)
				.where(eq(serviceReplicas.serviceId, serviceId));

			for (const replica of replicas) {
				if (replica.count > 0) {
					await tx.insert(serviceReplicas).values({
						id: randomUUID(),
						serviceId,
						serverId: replica.serverId,
						count: replica.count,
					});
				}
			}
		});
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
		// User stop is teardown; runtimeDesiredState "stopped" is reserved for
		// serverless sleep where the deployment must remain wakeable.
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
	const activeRolloutIds = await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);
		const activeRollouts = await tx
			.select({ id: rollouts.id })
			.from(rollouts)
			.where(
				and(
					eq(rollouts.serviceId, serviceId),
					inArray(rollouts.status, ["queued", "in_progress"]),
				),
			)
			.for("update");
		if (activeRollouts.length === 0) return [];

		const rolloutIds = activeRollouts.map((rollout) => rollout.id);
		await tx
			.update(rollouts)
			.set({
				status: "failed",
				currentStage: "aborted",
				completedAt: new Date(),
			})
			.where(inArray(rollouts.id, rolloutIds));
		await tx
			.update(deployments)
			.set({ trafficState: "active" })
			.where(
				and(
					eq(deployments.serviceId, serviceId),
					eq(deployments.trafficState, "draining"),
				),
			);

		const rolloutDeployments = await tx
			.select()
			.from(deployments)
			.where(inArray(deployments.rolloutId, rolloutIds));
		const serverContainers = new Map<string, string[]>();
		for (const deployment of rolloutDeployments) {
			if (!deployment.containerId) continue;
			const containers = serverContainers.get(deployment.serverId) ?? [];
			containers.push(deployment.containerId);
			serverContainers.set(deployment.serverId, containers);
		}

		for (const [serverId, containerIds] of serverContainers) {
			await enqueueWork(
				serverId,
				"force_cleanup",
				{ serviceId, containerIds },
				{ tx },
			);
		}
		await tx
			.delete(deployments)
			.where(inArray(deployments.rolloutId, rolloutIds));
		await enqueueReconcileForAllOnlineServers("rollout_aborted", tx);
		return rolloutIds;
	});

	if (activeRolloutIds.length === 0) {
		return { success: false, error: "No in-progress rollout found" };
	}

	for (const rolloutId of activeRolloutIds) {
		try {
			await inngest.send(inngestEvents.rolloutCancelled.create({ rolloutId }));
		} catch (error) {
			console.error(
				`[rollout:${rolloutId}] failed to send cancellation:`,
				error,
			);
		}
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

		return await db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`,
			);
			const service = await tx
				.select()
				.from(services)
				.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
				.then((rows) => rows[0]);
			if (!service) throw new Error("Service not found");
			if (service.previewOfService) {
				throw new Error("Preview services cannot have volumes");
			}
			if (service.previewDeploymentsEnabled) {
				throw new Error("Disable preview deployments before adding a volume");
			}
			if (service.placementMode === "automatic") {
				throw new Error("Switch to manual placement before adding a volume");
			}

			const configuredReplicas = await tx
				.select({ count: serviceReplicas.count })
				.from(serviceReplicas)
				.where(eq(serviceReplicas.serviceId, serviceId));
			const totalReplicas = configuredReplicas.reduce(
				(sum, replica) => sum + replica.count,
				0,
			);
			if (totalReplicas > 1) {
				throw new Error(
					"Volumes can only be added to services with 1 replica. Reduce replicas to 1 first.",
				);
			}

			const existing = await tx
				.select()
				.from(serviceVolumes)
				.where(eq(serviceVolumes.serviceId, serviceId));
			if (existing.some((volume) => volume.name === validatedName)) {
				throw new Error("Volume with this name already exists");
			}
			if (existing.some((volume) => volume.containerPath === validatedPath)) {
				throw new Error("A volume with this container path already exists");
			}

			const id = randomUUID();
			await tx.insert(serviceVolumes).values({
				id,
				serviceId,
				name: validatedName,
				containerPath: validatedPath,
			});
			if (!service.stateful) {
				await tx
					.update(services)
					.set({ stateful: true })
					.where(eq(services.id, serviceId));
			}
			return { id, name: validatedName, containerPath: validatedPath };
		});
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

	const hasRunning = activeDeployments.some(({ runtimeDesiredState }) =>
		isRuntimeExpected(runtimeDesiredState),
	);
	if (hasRunning) {
		throw new Error("Stop the service before removing volumes");
	}

	await db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext(${volume[0].serviceId}))`,
		);
		await tx.delete(serviceVolumes).where(eq(serviceVolumes.id, volumeId));

		const remainingVolumes = await tx
			.select({ id: serviceVolumes.id })
			.from(serviceVolumes)
			.where(eq(serviceVolumes.serviceId, volume[0].serviceId));

		if (remainingVolumes.length === 0 && service.stateful) {
			await tx
				.update(services)
				.set({ stateful: false })
				.where(eq(services.id, service.id));
		}
	});

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
