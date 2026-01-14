import { db } from "@/db";
import {
	services,
	serviceVolumes,
	volumeBackups,
	deployments,
} from "@/db/schema";
import { eq, and, lt, desc } from "drizzle-orm";
import { getBackupStorageConfig } from "@/db/queries";
import { enqueueWork } from "@/lib/work-queue";
import { randomUUID } from "node:crypto";
import { DEFAULT_BACKUP_RETENTION_DAYS } from "@/lib/settings-keys";
import { deleteBackup } from "@/actions/backups";

function shouldRunSchedule(
	schedule: string,
	lastBackupTime: Date | null,
): boolean {
	const now = new Date();
	const currentHour = now.getUTCHours();
	const currentMinute = now.getUTCMinutes();

	if (schedule === "daily") {
		if (currentHour !== 2 || currentMinute > 15) {
			return false;
		}

		if (lastBackupTime) {
			const hoursSince =
				(now.getTime() - lastBackupTime.getTime()) / (1000 * 60 * 60);
			if (hoursSince < 20) {
				return false;
			}
		}
		return true;
	}

	if (schedule === "weekly") {
		const dayOfWeek = now.getUTCDay();
		if (dayOfWeek !== 0 || currentHour !== 2 || currentMinute > 15) {
			return false;
		}

		if (lastBackupTime) {
			const daysSince =
				(now.getTime() - lastBackupTime.getTime()) / (1000 * 60 * 60 * 24);
			if (daysSince < 6) {
				return false;
			}
		}
		return true;
	}

	return false;
}

export async function runScheduledBackups() {
	const storageConfig = await getBackupStorageConfig();
	if (!storageConfig) {
		return;
	}

	const servicesWithBackup = await db
		.select({
			id: services.id,
			name: services.name,
			backupSchedule: services.backupSchedule,
		})
		.from(services)
		.where(eq(services.backupEnabled, true));

	for (const service of servicesWithBackup) {
		if (!service.backupSchedule) {
			continue;
		}

		try {
			const volumes = await db
				.select()
				.from(serviceVolumes)
				.where(eq(serviceVolumes.serviceId, service.id));

			if (volumes.length === 0) {
				continue;
			}

			const deployment = await db
				.select({
					serverId: deployments.serverId,
					containerId: deployments.containerId,
				})
				.from(deployments)
				.where(
					and(
						eq(deployments.serviceId, service.id),
						eq(deployments.status, "running"),
					),
				)
				.then((r) => r[0]);

			if (!deployment?.serverId) {
				continue;
			}

			if (!deployment.containerId) {
				console.error(
					`[backup-scheduler] deployment for ${service.name} is missing container ID`,
				);
				continue;
			}

			for (const volume of volumes) {
				const lastBackup = await db
					.select({ createdAt: volumeBackups.createdAt })
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

				if (
					!shouldRunSchedule(
						service.backupSchedule,
						lastBackup?.createdAt ?? null,
					)
				) {
					continue;
				}

				const backupId = randomUUID();
				const storagePath = `backups/${service.id}/${volume.name}/${backupId}.tar.gz`;

				await db.insert(volumeBackups).values({
					id: backupId,
					volumeId: volume.id,
					volumeName: volume.name,
					serviceId: service.id,
					serverId: deployment.serverId,
					status: "pending",
					storagePath,
				});

				await enqueueWork(deployment.serverId, "backup_volume", {
					backupId,
					serviceId: service.id,
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

				console.log(
					`[backup-scheduler] scheduled backup for ${service.name}/${volume.name}`,
				);
			}
		} catch (err) {
			console.error(
				`[backup-scheduler] error scheduling backup for ${service.name}:`,
				err,
			);
		}
	}
}

export async function cleanupOldBackups() {
	const storageConfig = await getBackupStorageConfig();
	const retentionDays =
		storageConfig?.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS;

	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

	const oldBackups = await db
		.select({ id: volumeBackups.id })
		.from(volumeBackups)
		.where(
			and(
				lt(volumeBackups.createdAt, cutoffDate),
				eq(volumeBackups.isMigrationBackup, false),
			),
		);

	if (oldBackups.length === 0) {
		return;
	}

	console.log(
		`[backup-scheduler] cleaning up ${oldBackups.length} old backups`,
	);

	for (const backup of oldBackups) {
		await deleteBackup(backup.id);
	}
}
