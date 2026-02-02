import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
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
import { inngest } from "../client";
import { deployService } from "@/actions/projects";

export const migrationWorkflow = inngest.createFunction(
	{
		id: "migration-workflow",
		cancelOn: [{ event: "migration/cancelled", match: "data.serviceId" }],
	},
	{ event: "migration/started" },
	async ({ event, step }) => {
		const {
			serviceId,
			targetServerId,
			sourceServerId,
			sourceDeploymentId,
			sourceContainerId,
			volumes,
			isDatabase,
		} = event.data;

		const storageConfig = await step.run("validate-storage", async () => {
			const config = await getBackupStorageConfig();
			if (!config) {
				throw new Error("Backup storage not configured");
			}
			return config;
		});

		const service = await step.run("get-service", async () => {
			const svc = await db
				.select()
				.from(services)
				.where(eq(services.id, serviceId))
				.then((r) => r[0]);

			if (!svc) {
				throw new Error("Service not found");
			}
			return svc;
		});

		if (!isDatabase) {
			await step.run("stop-source-volume", async () => {
				await db
					.update(services)
					.set({ migrationStatus: "stopping" })
					.where(eq(services.id, serviceId));

				await enqueueWork(sourceServerId, "stop", {
					deploymentId: sourceDeploymentId,
					containerId: sourceContainerId,
				});

				await db
					.update(deployments)
					.set({ status: "stopped" })
					.where(eq(deployments.id, sourceDeploymentId));
			});
		}

		const backupIds = await step.run("start-backups", async () => {
			await db
				.update(services)
				.set({ migrationStatus: "backing_up" })
				.where(eq(services.id, serviceId));

			const dbType = detectDatabaseType(service.image);
			const backupType = dbType ? "database" : "volume";
			const fileExtension = dbType
				? getDbBackupExtension(service.image)
				: ".tar.gz";
			const ids: string[] = [];

			for (const volume of volumes) {
				const backupId = randomUUID();
				ids.push(backupId);
				const storagePath = `migrations/${serviceId}/${volume.name}/${backupId}${fileExtension}`;

				await db.insert(volumeBackups).values({
					id: backupId,
					volumeId: volume.id,
					volumeName: volume.name,
					serviceId,
					serverId: sourceServerId,
					status: "pending",
					storagePath,
					isMigrationBackup: true,
				});

				await enqueueWork(sourceServerId, "backup_volume", {
					backupId,
					serviceId,
					containerId: isDatabase ? sourceContainerId : undefined,
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

			return ids;
		});

		const backupResults = await Promise.all(
			backupIds.map((backupId) =>
				step.waitForEvent(`wait-backup-${backupId}`, {
					event: "migration/backup-completed",
					timeout: "30m",
					if: `async.data.backupId == "${backupId}" && async.data.serviceId == "${serviceId}"`,
				}),
			),
		);

		const backupFailed = backupResults.some((r) => r === null);
		if (backupFailed) {
			await step.run("handle-backup-timeout", async () => {
				await db
					.update(services)
					.set({
						migrationStatus: "failed",
						migrationError: "Backup timed out",
					})
					.where(eq(services.id, serviceId));
			});
			return { status: "failed", reason: "backup_timeout" };
		}

		if (isDatabase) {
			await step.run("stop-source-db", async () => {
				await db
					.update(services)
					.set({ migrationStatus: "stopping" })
					.where(eq(services.id, serviceId));

				await enqueueWork(sourceServerId, "stop", {
					deploymentId: sourceDeploymentId,
					containerId: sourceContainerId,
				});

				await db
					.update(deployments)
					.set({ status: "stopped" })
					.where(eq(deployments.id, sourceDeploymentId));
			});
		}

		if (!isDatabase) {
			await step.run("restore-volumes", async () => {
				await db
					.update(services)
					.set({ migrationStatus: "restoring" })
					.where(eq(services.id, serviceId));

				const backups = await db
					.select()
					.from(volumeBackups)
					.where(
						and(
							eq(volumeBackups.serviceId, serviceId),
							eq(volumeBackups.isMigrationBackup, true),
							eq(volumeBackups.status, "completed"),
						),
					);

				for (const backup of backups) {
					if (!backup.storagePath || !backup.checksum) continue;

					await enqueueWork(targetServerId, "restore_volume", {
						backupId: backup.id,
						serviceId,
						volumeName: backup.volumeName,
						storagePath: backup.storagePath,
						expectedChecksum: backup.checksum,
						backupType: "volume",
						serviceImage: service.image,
						isMigrationRestore: true,
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
			});

			const restoreResults = await Promise.all(
				backupIds.map((backupId) =>
					step.waitForEvent(`wait-restore-${backupId}`, {
						event: "migration/restore-completed",
						timeout: "30m",
						if: `async.data.backupId == "${backupId}" && async.data.serviceId == "${serviceId}"`,
					}),
				),
			);

			const restoreFailed = restoreResults.some((r) => r === null);
			if (restoreFailed) {
				await step.run("handle-restore-timeout", async () => {
					await db
						.update(services)
						.set({
							migrationStatus: "failed",
							migrationError: "Restore timed out",
						})
						.where(eq(services.id, serviceId));
				});
				return { status: "failed", reason: "restore_timeout" };
			}
		}

		await step.run("deploy-target", async () => {
			await db
				.update(services)
				.set({ migrationStatus: "starting" })
				.where(eq(services.id, serviceId));

			await db
				.delete(serviceReplicas)
				.where(eq(serviceReplicas.serviceId, serviceId));

			await db.insert(serviceReplicas).values({
				id: randomUUID(),
				serviceId,
				serverId: targetServerId,
				count: 1,
			});

			await db
				.update(services)
				.set({ lockedServerId: targetServerId })
				.where(eq(services.id, serviceId));

			await deployService(serviceId);
		});

		if (isDatabase) {
			await step.waitForEvent("wait-deployment-healthy", {
				event: "deployment/healthy",
				timeout: "10m",
				if: `async.data.serviceId == "${serviceId}"`,
			});

			const targetContainerId = await step.run(
				"get-target-container",
				async () => {
					const deployment = await db
						.select({ containerId: deployments.containerId })
						.from(deployments)
						.where(
							and(
								eq(deployments.serviceId, serviceId),
								eq(deployments.serverId, targetServerId),
							),
						)
						.orderBy(desc(deployments.createdAt))
						.limit(1)
						.then((r) => r[0]);

					if (!deployment?.containerId) {
						throw new Error("Target container not found");
					}

					return deployment.containerId;
				},
			);

			await step.run("restore-database", async () => {
				await db
					.update(services)
					.set({ migrationStatus: "restoring" })
					.where(eq(services.id, serviceId));

				const backups = await db
					.select()
					.from(volumeBackups)
					.where(
						and(
							eq(volumeBackups.serviceId, serviceId),
							eq(volumeBackups.isMigrationBackup, true),
							eq(volumeBackups.status, "completed"),
						),
					);

				for (const backup of backups) {
					if (!backup.storagePath || !backup.checksum) continue;

					const backupType = detectBackupTypeFromPath(backup.storagePath);

					await enqueueWork(targetServerId, "restore_volume", {
						backupId: backup.id,
						serviceId,
						containerId: targetContainerId,
						volumeName: backup.volumeName,
						storagePath: backup.storagePath,
						expectedChecksum: backup.checksum,
						backupType,
						serviceImage: service.image,
						isMigrationRestore: true,
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
			});

			const restoreResults = await Promise.all(
				backupIds.map((backupId) =>
					step.waitForEvent(`wait-restore-${backupId}`, {
						event: "migration/restore-completed",
						timeout: "30m",
						if: `async.data.backupId == "${backupId}" && async.data.serviceId == "${serviceId}"`,
					}),
				),
			);

			const restoreFailed = restoreResults.some((r) => r === null);
			if (restoreFailed) {
				await step.run("handle-db-restore-timeout", async () => {
					await db
						.update(services)
						.set({
							migrationStatus: "failed",
							migrationError: "Database restore timed out",
						})
						.where(eq(services.id, serviceId));
				});
				return { status: "failed", reason: "restore_timeout" };
			}
		}

		await step.run("complete-migration", async () => {
			await db
				.update(services)
				.set({
					migrationStatus: null,
					migrationTargetServerId: null,
					migrationBackupId: null,
					migrationError: null,
				})
				.where(eq(services.id, serviceId));
		});

		return { status: "completed", serviceId };
	},
);

function getDbBackupExtension(image: string): string {
	const imageLower = image.toLowerCase();
	if (imageLower.includes("postgres")) return ".dump";
	if (imageLower.includes("mysql")) return ".sql";
	if (imageLower.includes("mariadb")) return ".sql";
	if (imageLower.includes("mongo")) return ".archive.gz";
	if (imageLower.includes("redis")) return ".rdb";
	return ".backup";
}

function detectBackupTypeFromPath(storagePath: string): "volume" | "database" {
	if (storagePath.endsWith(".tar.gz")) return "volume";
	if (storagePath.endsWith(".dump")) return "database";
	if (storagePath.endsWith(".sql")) return "database";
	if (storagePath.endsWith(".archive.gz")) return "database";
	if (storagePath.endsWith(".rdb")) return "database";
	return "volume";
}
