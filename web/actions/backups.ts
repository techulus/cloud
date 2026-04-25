"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { getBackupStorageConfig } from "@/db/queries";
import { servers, volumeBackups } from "@/db/schema";
import { triggerBackup } from "@/lib/backups/trigger-backup";
import { inngest } from "@/lib/inngest/client";
import { deleteFromS3 } from "@/lib/s3";

export async function createBackup(
	serviceId: string,
	volumeId: string,
	backupTypeOverride?: "volume" | "database",
) {
	const result = await triggerBackup({
		serviceId,
		volumeId,
		backupTypeOverride,
	});

	await inngest.send({
		name: "backup/started",
		data: {
			backupId: result.backupId,
			serviceId,
			volumeId,
			serverId: result.serverId,
		},
	});

	revalidatePath(`/dashboard/projects`);
	return { success: true, backupId: result.backupId };
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
	await inngest.send({
		name: "restore/trigger",
		data: {
			serviceId,
			backupId,
			targetServerId,
		},
	});

	revalidatePath(`/dashboard/projects`);
	return { success: true };
}

export async function deleteBackup(backupId: string) {
	const backup = await db
		.select({
			status: volumeBackups.status,
			storagePath: volumeBackups.storagePath,
		})
		.from(volumeBackups)
		.where(eq(volumeBackups.id, backupId))
		.then((r) => r[0]);

	await db.delete(volumeBackups).where(eq(volumeBackups.id, backupId));
	revalidatePath(`/dashboard/projects`);

	if (backup?.status === "completed" && backup.storagePath) {
		const storageConfig = await getBackupStorageConfig();
		if (storageConfig) {
			try {
				await deleteFromS3(storageConfig.bucket, backup.storagePath);
			} catch (err) {
				console.error("[deleteBackup] failed to delete from S3:", {
					backupId,
					storagePath: backup.storagePath,
					err,
				});
			}
		}
	}

	return { success: true };
}
