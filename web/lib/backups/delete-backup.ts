import { eq } from "drizzle-orm";
import { db } from "@/db";
import { getBackupStorageConfig } from "@/db/queries";
import { volumeBackups } from "@/db/schema";
import { deleteFromS3 } from "@/lib/s3";

/**
 * Deletes a backup record and its S3 object.
 * Intended for trusted internal callers (Inngest crons, schedulers).
 * User-facing entry points must enforce auth before calling this.
 */
export async function deleteBackupInternal(backupId: string) {
	const backup = await db
		.select({
			status: volumeBackups.status,
			storagePath: volumeBackups.storagePath,
		})
		.from(volumeBackups)
		.where(eq(volumeBackups.id, backupId))
		.then((r) => r[0]);

	await db.delete(volumeBackups).where(eq(volumeBackups.id, backupId));

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

	return { success: true as const };
}
