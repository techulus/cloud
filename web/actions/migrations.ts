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
import { enqueueWork } from "@/lib/work-queue";
import { revalidatePath } from "next/cache";

export async function startMigration(serviceId: string, targetServerId: string) {
	const storageConfig = await getBackupStorageConfig();
	if (!storageConfig) {
		throw new Error("Backup storage not configured. Configure it in Settings first.");
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
			and(eq(deployments.serviceId, serviceId), eq(deployments.status, "running")),
		)
		.then((r) => r[0]);

	if (!deployment?.serverId) {
		throw new Error("No running deployment found");
	}

	if (deployment.serverId === targetServerId) {
		throw new Error("Service is already running on the target server");
	}

	await db
		.update(services)
		.set({
			migrationStatus: "stopping",
			migrationTargetServerId: targetServerId,
			migrationBackupId: null,
			migrationError: null,
		})
		.where(eq(services.id, serviceId));

	if (deployment.containerId) {
		await enqueueWork(deployment.serverId, "stop", {
			deploymentId: deployment.id,
			containerId: deployment.containerId,
		});
	}

	await db
		.update(deployments)
		.set({ status: "stopped" })
		.where(eq(deployments.id, deployment.id));

	await db
		.update(services)
		.set({ migrationStatus: "backing_up" })
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
			volumeName: volume.name,
			storagePath,
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
	const service = await db
		.select()
		.from(services)
		.where(eq(services.migrationBackupId, backupId))
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

	await db
		.update(services)
		.set({ migrationStatus: "restoring" })
		.where(eq(services.id, service.id));

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

	for (const backup of backups) {
		if (!backup.storagePath || !backup.checksum) {
			continue;
		}

		await enqueueWork(targetServerId, "restore_volume", {
			backupId: backup.id,
			serviceId: service.id,
			volumeName: backup.volumeName,
			storagePath: backup.storagePath,
			expectedChecksum: backup.checksum,
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

	await db.delete(serviceReplicas).where(eq(serviceReplicas.serviceId, service.id));

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

	await db
		.update(services)
		.set({
			migrationStatus: null,
			migrationTargetServerId: null,
			migrationBackupId: null,
			migrationError: null,
		})
		.where(eq(services.id, service.id));
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
