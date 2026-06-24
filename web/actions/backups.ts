"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { getBackupStorageConfig } from "@/db/queries";
import { volumeBackups } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { triggerBackup } from "@/lib/backups/trigger-backup";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { deleteFromS3 } from "@/lib/s3";

export async function createBackup(serviceId: string, volumeId: string) {
	await requireAuth();
	const result = await triggerBackup({
		serviceId,
		volumeId,
	});

	await inngest.send(
		inngestEvents.backupStarted.create({
			backupId: result.backupId,
			serviceId,
			volumeId,
			serverId: result.serverId,
		}),
	);

	revalidatePath(`/dashboard/projects`);
	return { success: true, backupId: result.backupId };
}

export async function restoreBackup(
	serviceId: string,
	backupId: string,
	targetServerId?: string,
) {
	await requireAuth();
	await inngest.send(
		inngestEvents.restoreTrigger.create({
			serviceId,
			backupId,
			targetServerId,
		}),
	);

	revalidatePath(`/dashboard/projects`);
	return { success: true };
}

export async function deleteBackup(
	backupId: string,
	options: { revalidate?: boolean } = {},
) {
	await requireAuth();
	const backup = await db
		.select({
			status: volumeBackups.status,
			storagePath: volumeBackups.storagePath,
		})
		.from(volumeBackups)
		.where(eq(volumeBackups.id, backupId))
		.then((r) => r[0]);

	await db.delete(volumeBackups).where(eq(volumeBackups.id, backupId));
	if (options.revalidate ?? true) {
		revalidatePath(`/dashboard/projects`);
	}

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
