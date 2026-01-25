"use server";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
	services,
	serviceVolumes,
	volumeBackups,
	deployments,
	serviceReplicas,
} from "@/db/schema";
import { getBackupStorageConfig } from "@/db/queries";
import { detectDatabaseType } from "@/lib/database-utils";
import { enqueueWork } from "@/lib/work-queue";
import { revalidatePath } from "next/cache";
import { deployService } from "./projects";

export async function startMigration(
	serviceId: string,
	targetServerId: string,
) {
	const storageConfig = await getBackupStorageConfig();
	if (!storageConfig) {
		throw new Error(
			"Backup storage not configured. Configure it in Settings first.",
		);
	}

	const service = await db
		.select()
		.from(services)
		.where(eq(services.id, serviceId))
		.then((r) => r[0]);

	if (!service) {
		throw new Error("Service not found");
	}

	if (!service.stateful) {
		throw new Error("Only stateful services can be migrated");
	}

	if (service.migrationStatus) {
		throw new Error("Migration already in progress");
	}

	const volumes = await db
		.select()
		.from(serviceVolumes)
		.where(eq(serviceVolumes.serviceId, serviceId));

	if (volumes.length === 0) {
		throw new Error("No volumes found for this service");
	}

	const deployment = await db
		.select({
			id: deployments.id,
			serverId: deployments.serverId,
			containerId: deployments.containerId,
		})
		.from(deployments)
		.where(
			and(
				eq(deployments.serviceId, serviceId),
				eq(deployments.status, "running"),
			),
		)
		.then((r) => r[0]);

	if (!deployment?.serverId) {
		throw new Error("No running deployment found");
	}

	if (!deployment.containerId) {
		throw new Error("Deployment is missing container ID");
	}

	if (deployment.serverId === targetServerId) {
		throw new Error("Service is already running on the target server");
	}

	const backupType = detectDatabaseType(service.image) ? "database" : "volume";

	if (backupType === "volume") {
		await db
			.update(services)
			.set({
				migrationStatus: "stopping",
				migrationTargetServerId: targetServerId,
				migrationBackupId: null,
				migrationError: null,
			})
			.where(eq(services.id, serviceId));

		await enqueueWork(deployment.serverId, "stop", {
			deploymentId: deployment.id,
			containerId: deployment.containerId,
		});

		await db
			.update(deployments)
			.set({ status: "stopped" })
			.where(eq(deployments.id, deployment.id));
	}

	await db
		.update(services)
		.set({
			migrationStatus: "backing_up",
			migrationTargetServerId: targetServerId,
			migrationBackupId: null,
			migrationError: null,
		})
		.where(eq(services.id, serviceId));

	for (const volume of volumes) {
		const backupId = randomUUID();
		const storagePath = `migrations/${serviceId}/${volume.name}/${backupId}.tar.gz`;

		await db.insert(volumeBackups).values({
			id: backupId,
			volumeId: volume.id,
			volumeName: volume.name,
			serviceId,
			serverId: deployment.serverId,
			status: "pending",
			storagePath,
			isMigrationBackup: true,
		});

		if (volumes.indexOf(volume) === volumes.length - 1) {
			await db
				.update(services)
				.set({ migrationBackupId: backupId })
				.where(eq(services.id, serviceId));
		}

		await enqueueWork(deployment.serverId, "backup_volume", {
			backupId,
			serviceId,
			containerId: deployment.containerId,
			volumeName: volume.name,
			storagePath,
			backupType,
			serviceImage: service.image,
			storageConfig: {
				provider: storageConfig.provider,
				bucket: storageConfig.bucket,
				region: storageConfig.region,
				endpoint: storageConfig.endpoint,
				accessKey: storageConfig.accessKey,
				secretKey: storageConfig.secretKey,
			},
		});
	}

	revalidatePath(`/dashboard/projects`);
	return { success: true };
}

export async function continueMigrationAfterBackup(backupId: string) {
	const backup = await db
		.select()
		.from(volumeBackups)
		.where(eq(volumeBackups.id, backupId))
		.then((r) => r[0]);

	// Ignore non-migration backups or unknown backup ids
	if (!backup || !backup.isMigrationBackup || !backup.serviceId) {
		return;
	}

	const service = await db
		.select()
		.from(services)
		.where(eq(services.id, backup.serviceId))
		.then((r) => r[0]);

	if (!service) {
		return;
	}

	if (service.migrationStatus !== "backing_up") {
		return;
	}

	const storageConfig = await getBackupStorageConfig();
	if (!storageConfig) {
		await db
			.update(services)
			.set({
				migrationStatus: "failed",
				migrationError: "Backup storage not configured",
			})
			.where(eq(services.id, service.id));
		return;
	}

	const backups = await db
		.select()
		.from(volumeBackups)
		.where(
			and(
				eq(volumeBackups.serviceId, service.id),
				eq(volumeBackups.isMigrationBackup, true),
			),
		);

	const allCompleted = backups.every((b) => b.status === "completed");
	const anyFailed = backups.some((b) => b.status === "failed");

	if (anyFailed) {
		await db
			.update(services)
			.set({
				migrationStatus: "failed",
				migrationError: "Backup failed",
			})
			.where(eq(services.id, service.id));
		return;
	}

	if (!allCompleted) {
		return;
	}

	const targetServerId = service.migrationTargetServerId;
	if (!targetServerId) {
		await db
			.update(services)
			.set({
				migrationStatus: "failed",
				migrationError: "Target server not set",
			})
			.where(eq(services.id, service.id));
		return;
	}

	const dbType = detectDatabaseType(service.image);
	const isRedis = service.image.toLowerCase().includes("redis");
	const isSqlDatabase = dbType && !isRedis;

	const deployment = await db
		.select({
			id: deployments.id,
			serverId: deployments.serverId,
			containerId: deployments.containerId,
		})
		.from(deployments)
		.where(eq(deployments.serviceId, service.id))
		.then((r) => r[0]);

	if (isSqlDatabase) {
		if (deployment?.containerId && deployment.serverId) {
			await db
				.update(services)
				.set({ migrationStatus: "stopping" })
				.where(eq(services.id, service.id));

			await enqueueWork(deployment.serverId, "stop", {
				deploymentId: deployment.id,
				containerId: deployment.containerId,
			});

			await db
				.update(deployments)
				.set({ status: "stopped" })
				.where(eq(deployments.id, deployment.id));
		}

		await db
			.update(services)
			.set({ migrationStatus: "deploying_target" })
			.where(eq(services.id, service.id));

		await db
			.delete(serviceReplicas)
			.where(eq(serviceReplicas.serviceId, service.id));

		await db.insert(serviceReplicas).values({
			id: randomUUID(),
			serviceId: service.id,
			serverId: targetServerId,
			count: 1,
		});

		await db
			.update(services)
			.set({ lockedServerId: targetServerId })
			.where(eq(services.id, service.id));

		try {
			await deployService(service.id);
		} catch (error) {
			console.error(
				`[migration] failed to deploy for ${service.id}:`,
				error,
			);
			await db
				.update(services)
				.set({
					migrationStatus: "failed",
					migrationError:
						error instanceof Error ? error.message : "Deployment failed",
				})
				.where(eq(services.id, service.id));
		}

		revalidatePath(`/dashboard/projects`);
		return;
	}

	await db
		.update(services)
		.set({ migrationStatus: "restoring" })
		.where(eq(services.id, service.id));

	for (const backup of backups) {
		if (!backup.storagePath || !backup.checksum) {
			await db
				.update(services)
				.set({
					migrationStatus: "failed",
					migrationError: `Backup ${backup.id} is missing required data (storagePath or checksum)`,
				})
				.where(eq(services.id, service.id));
			return;
		}

		const backupType = detectBackupTypeFromPath(backup.storagePath);

		await enqueueWork(targetServerId, "restore_volume", {
			backupId: backup.id,
			serviceId: service.id,
			volumeName: backup.volumeName,
			storagePath: backup.storagePath,
			expectedChecksum: backup.checksum,
			backupType,
			serviceImage: service.image,
			storageConfig: {
				provider: storageConfig.provider,
				bucket: storageConfig.bucket,
				region: storageConfig.region,
				endpoint: storageConfig.endpoint,
				accessKey: storageConfig.accessKey,
				secretKey: storageConfig.secretKey,
			},
		});
	}

	await db
		.delete(serviceReplicas)
		.where(eq(serviceReplicas.serviceId, service.id));

	await db.insert(serviceReplicas).values({
		id: randomUUID(),
		serviceId: service.id,
		serverId: targetServerId,
		count: 1,
	});

	await db
		.update(services)
		.set({
			migrationStatus: "starting",
			lockedServerId: targetServerId,
		})
		.where(eq(services.id, service.id));

	try {
		await deployService(service.id);
		await db
			.update(services)
			.set({
				migrationStatus: null,
				migrationTargetServerId: null,
				migrationBackupId: null,
				migrationError: null,
			})
			.where(eq(services.id, service.id));
	} catch (error) {
		console.error(
			`[migration] failed to trigger deployment for ${service.id}:`,
			error,
		);
		await db
			.update(services)
			.set({
				migrationStatus: "failed",
				migrationError:
					error instanceof Error ? error.message : "Deployment failed",
			})
			.where(eq(services.id, service.id));
		throw error;
	}

	revalidatePath(`/dashboard/projects`);
}

export async function continueMigrationAfterDeploy(deploymentId: string) {
	const deployment = await db
		.select()
		.from(deployments)
		.where(eq(deployments.id, deploymentId))
		.then((r) => r[0]);

	if (!deployment) return;

	const service = await db
		.select()
		.from(services)
		.where(eq(services.id, deployment.serviceId))
		.then((r) => r[0]);

	if (!service || service.migrationStatus !== "deploying_target") return;

	const storageConfig = await getBackupStorageConfig();
	if (!storageConfig) {
		await db
			.update(services)
			.set({
				migrationStatus: "failed",
				migrationError: "Backup storage not configured",
			})
			.where(eq(services.id, service.id));
		return;
	}

	if (!deployment.containerId) {
		await db
			.update(services)
			.set({
				migrationStatus: "failed",
				migrationError: "Target deployment has no container ID",
			})
			.where(eq(services.id, service.id));
		return;
	}

	const backups = await db
		.select()
		.from(volumeBackups)
		.where(
			and(
				eq(volumeBackups.serviceId, service.id),
				eq(volumeBackups.isMigrationBackup, true),
			),
		);

	await db
		.update(services)
		.set({ migrationStatus: "restoring" })
		.where(eq(services.id, service.id));

	for (const backup of backups) {
		if (!backup.storagePath || !backup.checksum) {
			await db
				.update(services)
				.set({
					migrationStatus: "failed",
					migrationError: `Backup ${backup.id} is missing required data`,
				})
				.where(eq(services.id, service.id));
			return;
		}

		await enqueueWork(deployment.serverId, "restore_volume", {
			backupId: backup.id,
			serviceId: service.id,
			containerId: deployment.containerId,
			volumeName: backup.volumeName,
			storagePath: backup.storagePath,
			expectedChecksum: backup.checksum,
			backupType: detectBackupTypeFromPath(backup.storagePath),
			serviceImage: service.image,
			storageConfig: {
				provider: storageConfig.provider,
				bucket: storageConfig.bucket,
				region: storageConfig.region,
				endpoint: storageConfig.endpoint,
				accessKey: storageConfig.accessKey,
				secretKey: storageConfig.secretKey,
			},
		});
	}

	await db
		.update(services)
		.set({
			migrationStatus: null,
			migrationTargetServerId: null,
			migrationBackupId: null,
			migrationError: null,
		})
		.where(eq(services.id, service.id));

	revalidatePath(`/dashboard/projects`);
}

export async function cancelMigration(serviceId: string) {
	await db
		.update(services)
		.set({
			migrationStatus: null,
			migrationTargetServerId: null,
			migrationBackupId: null,
			migrationError: null,
		})
		.where(eq(services.id, serviceId));

	revalidatePath(`/dashboard/projects`);
	return { success: true };
}

export async function getMigrationStatus(serviceId: string) {
	const service = await db
		.select({
			migrationStatus: services.migrationStatus,
			migrationError: services.migrationError,
		})
		.from(services)
		.where(eq(services.id, serviceId))
		.then((r) => r[0]);

	return service ?? null;
}

function detectBackupTypeFromPath(storagePath: string): "volume" | "database" {
	if (storagePath.endsWith(".tar.gz")) return "volume";
	if (storagePath.endsWith(".dump")) return "database";
	if (storagePath.endsWith(".sql")) return "database";
	if (storagePath.endsWith(".archive.gz")) return "database";
	if (storagePath.endsWith(".rdb")) return "database";
	return "volume";
}
