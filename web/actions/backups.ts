"use server";

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
	serviceVolumes,
	volumeBackups,
	services,
	deployments,
	servers,
} from "@/db/schema";
import { getBackupStorageConfig } from "@/db/queries";
import { enqueueWork } from "@/lib/work-queue";
import { revalidatePath } from "next/cache";
import { deleteFromS3 } from "@/lib/s3";

export async function createBackup(serviceId: string, volumeId: string) {
	const storageConfig = await getBackupStorageConfig();
	if (!storageConfig) {
		throw new Error("Backup storage not configured");
	}

	const volume = await db
		.select()
		.from(serviceVolumes)
		.where(eq(serviceVolumes.id, volumeId))
		.then((r) => r[0]);

	if (!volume) {
		throw new Error("Volume not found");
	}

	const service = await db
		.select()
		.from(services)
		.where(eq(services.id, serviceId))
		.then((r) => r[0]);

	if (!service) {
		throw new Error("Service not found");
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

	if (!deployment || !deployment.serverId) {
		throw new Error("No running deployment found for this service");
	}

	if (!deployment.containerId) {
		throw new Error("Deployment is missing container ID");
	}

	const backupId = randomUUID();
	const storagePath = `backups/${serviceId}/${volume.name}/${backupId}.tar.gz`;

	await db.insert(volumeBackups).values({
		id: backupId,
		volumeId,
		volumeName: volume.name,
		serviceId,
		serverId: deployment.serverId,
		status: "pending",
		storagePath,
	});

	await enqueueWork(deployment.serverId, "backup_volume", {
		backupId,
		serviceId,
		containerId: deployment.containerId,
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

	revalidatePath(`/dashboard/projects`);
	return { success: true, backupId };
}

export async function listBackups(serviceId: string) {
	const backups = await db
		.select({
			id: volumeBackups.id,
			volumeName: volumeBackups.volumeName,
			status: volumeBackups.status,
			sizeBytes: volumeBackups.sizeBytes,
			createdAt: volumeBackups.createdAt,
			completedAt: volumeBackups.completedAt,
			errorMessage: volumeBackups.errorMessage,
			serverName: servers.name,
		})
		.from(volumeBackups)
		.leftJoin(servers, eq(volumeBackups.serverId, servers.id))
		.where(eq(volumeBackups.serviceId, serviceId))
		.orderBy(desc(volumeBackups.createdAt));

	return backups;
}

export async function restoreBackup(
	serviceId: string,
	backupId: string,
	targetServerId?: string,
) {
	const storageConfig = await getBackupStorageConfig();
	if (!storageConfig) {
		throw new Error("Backup storage not configured");
	}

	const backup = await db
		.select()
		.from(volumeBackups)
		.where(eq(volumeBackups.id, backupId))
		.then((r) => r[0]);

	if (!backup) {
		throw new Error("Backup not found");
	}

	if (backup.status !== "completed") {
		throw new Error("Cannot restore incomplete backup");
	}

	if (!backup.storagePath || !backup.checksum) {
		throw new Error("Backup data is incomplete");
	}

	const deployment = await db
		.select({
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

	if (!deployment || !deployment.serverId) {
		throw new Error("No running deployment found for this service");
	}

	const serverId = targetServerId ?? deployment.serverId;

	await enqueueWork(serverId, "restore_volume", {
		backupId,
		serviceId,
		containerId: deployment.containerId,
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

	revalidatePath(`/dashboard/projects`);
	return { success: true };
}

export async function deleteBackup(backupId: string) {
	const backup = await db
		.select({ storagePath: volumeBackups.storagePath })
		.from(volumeBackups)
		.where(eq(volumeBackups.id, backupId))
		.then((r) => r[0]);

	if (backup?.storagePath) {
		const storageConfig = await getBackupStorageConfig();
		if (storageConfig) {
			try {
				await deleteFromS3(storageConfig.bucket, backup.storagePath);
			} catch (err) {
				console.error("[deleteBackup] failed to delete from S3:", err);
			}
		}
	}

	await db.delete(volumeBackups).where(eq(volumeBackups.id, backupId));
	revalidatePath(`/dashboard/projects`);
	return { success: true };
}
