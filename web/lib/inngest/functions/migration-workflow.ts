import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { deployService } from "@/actions/projects";
import { db } from "@/db";
import { getBackupStorageConfig } from "@/db/queries";
import {
	deployments,
	serviceReplicas,
	services,
	volumeBackups,
} from "@/db/schema";
import { enqueueWork } from "@/lib/work-queue";
import { inngest } from "../client";
import { inngestEvents } from "../events";

export const migrationWorkflow = inngest.createFunction(
	{
		id: "migration-workflow",
		triggers: [inngestEvents.migrationStarted],
		cancelOn: [
			{ event: inngestEvents.migrationCancelled, match: "data.serviceId" },
		],
	},
	async ({ event, step, group }) => {
		const {
			serviceId,
			targetServerId,
			sourceServerId,
			sourceDeploymentId,
			sourceContainerId,
			volumes,
		} = event.data;

		const storageConfig = await step.run("validate-storage", async () => {
			const config = await getBackupStorageConfig();
			if (!config) {
				throw new Error("Backup storage not configured");
			}
			return config;
		});

		await step.run("get-service", async () => {
			const svc = await db
				.select()
				.from(services)
				.where(eq(services.id, serviceId))
				.then((r) => r[0]);

			if (!svc) {
				throw new Error("Service not found");
			}
		});

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

		const backupIds = await step.run("start-backups", async () => {
			await db
				.update(services)
				.set({ migrationStatus: "backing_up" })
				.where(eq(services.id, serviceId));

			const ids: string[] = [];

			for (const volume of volumes) {
				const backupId = randomUUID();
				ids.push(backupId);
				const storagePath = `migrations/${serviceId}/${volume.name}/${backupId}.tar.gz`;

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
					containerId: sourceContainerId,
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

			return ids;
		});

		const backupResults = await Promise.all(
			backupIds.map((backupId) =>
				group.parallel(() => {
					const completedPromise = step
						.waitForEvent(`wait-backup-${backupId}`, {
							event: inngestEvents.migrationBackupCompleted,
							timeout: "30m",
							if: `async.data.backupId == "${backupId}" && async.data.serviceId == "${serviceId}"`,
						})
						.then((result) => ({ status: "completed" as const, result }));

					const failedPromise = step
						.waitForEvent(`wait-backup-failed-${backupId}`, {
							event: inngestEvents.migrationBackupFailed,
							timeout: "30m",
							if: `async.data.backupId == "${backupId}" && async.data.serviceId == "${serviceId}"`,
						})
						.then((result) => ({ status: "failed" as const, result }));

					return Promise.race([completedPromise, failedPromise]);
				}),
			),
		);

		const backupTimedOut = backupResults.some((r) => r.result === null);
		if (backupTimedOut) {
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

		const backupFailure = backupResults.find((r) => r.status === "failed");
		if (backupFailure) {
			await step.run("handle-backup-failure", async () => {
				await db
					.update(services)
					.set({
						migrationStatus: "failed",
						migrationError: backupFailure.result?.data.error || "Backup failed",
					})
					.where(eq(services.id, serviceId));
			});
			return { status: "failed", reason: "backup_failed" };
		}

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
				group.parallel(() => {
					const completedPromise = step
						.waitForEvent(`wait-restore-${backupId}`, {
							event: inngestEvents.migrationRestoreCompleted,
							timeout: "30m",
							if: `async.data.backupId == "${backupId}" && async.data.serviceId == "${serviceId}"`,
						})
						.then((result) => ({ status: "completed" as const, result }));

					const failedPromise = step
						.waitForEvent(`wait-restore-failed-${backupId}`, {
							event: inngestEvents.migrationRestoreFailed,
							timeout: "30m",
							if: `async.data.backupId == "${backupId}" && async.data.serviceId == "${serviceId}"`,
						})
						.then((result) => ({ status: "failed" as const, result }));

					return Promise.race([completedPromise, failedPromise]);
				}),
			),
		);

		const restoreTimedOut = restoreResults.some((r) => r.result === null);
		if (restoreTimedOut) {
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

		const restoreFailure = restoreResults.find((r) => r.status === "failed");
		if (restoreFailure) {
			await step.run("handle-restore-failure", async () => {
				await db
					.update(services)
					.set({
						migrationStatus: "failed",
						migrationError:
							restoreFailure.result?.data.error || "Restore failed",
					})
					.where(eq(services.id, serviceId));
			});
			return { status: "failed", reason: "restore_failed" };
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
