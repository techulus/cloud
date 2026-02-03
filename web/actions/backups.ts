"use server";

import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { volumeBackups, servers } from "@/db/schema";
import { revalidatePath } from "next/cache";
import { deleteFromS3 } from "@/lib/s3";
import { getBackupStorageConfig } from "@/db/queries";
import { inngest } from "@/lib/inngest/client";

export async function createBackup(
	serviceId: string,
	volumeId: string,
	backupTypeOverride?: "volume" | "database",
) {
	await inngest.send({
		name: "backup/trigger",
		data: {
			serviceId,
			volumeId,
			backupTypeOverride,
		},
	});

	revalidatePath(`/dashboard/projects`);
	return { success: true };
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
