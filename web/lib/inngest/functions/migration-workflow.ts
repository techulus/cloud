import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { getBackupStorageConfig } from "@/db/queries";
import {
	deployments,
	serviceReplicas,
	services,
	volumeBackups,
} from "@/db/schema";
import { deployServiceInternal } from "@/lib/deploy-service";
import { markDeploymentRemoved } from "@/lib/deployment-status";
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
			sourceServiceRevisionId,
			sourceContainerId,
			volumes,
			actor = null,
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
				.set(markDeploymentRemoved())
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
				group.parallel(
					async (): Promise<{
						status: "completed" | "failed" | "pending" | "timed_out";
						error?: string;
					}> => {
						const readBackup = async () =>
							db
								.select({
									status: volumeBackups.status,
									errorMessage: volumeBackups.errorMessage,
								})
								.from(volumeBackups)
								.where(eq(volumeBackups.id, backupId))
								.then((r) => r[0]);

						const before = await step.run(
							`check-backup-${backupId}-before`,
							readBackup,
						);
						if (before?.status === "completed") {
							return { status: "completed" as const };
						}
						if (before?.status === "failed") {
							return {
								status: "failed" as const,
								error: before.errorMessage || "Backup failed",
							};
						}

						const wakeup = await step.waitForEvent(
							`wait-backup-status-${backupId}`,
							{
								event: inngestEvents.resourceStatusChanged,
								timeout: "30m",
								if: `async.data.type == "backup" && async.data.id == "${backupId}"`,
							},
						);

						const after = await step.run(
							`check-backup-${backupId}-after`,
							readBackup,
						);
						if (after?.status === "completed") {
							return { status: "completed" as const };
						}
						if (after?.status === "failed") {
							return {
								status: "failed" as const,
								error: after.errorMessage || "Backup failed",
							};
						}

						return { status: wakeup ? "pending" : "timed_out" } as const;
					},
				),
			),
		);

		const backupTimedOut = backupResults.some((r) => r.status === "timed_out");
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

		const backupStillPending = backupResults.some(
			(r) => r.status === "pending",
		);
		if (backupStillPending) {
			await step.run("handle-backup-still-pending", async () => {
				await db
					.update(services)
					.set({
						migrationStatus: "failed",
						migrationError: "Backup did not reach a terminal state",
					})
					.where(eq(services.id, serviceId));
			});
			return { status: "failed", reason: "backup_pending" };
		}

		const backupFailure = backupResults.find((r) => r.status === "failed");
		if (backupFailure) {
			await step.run("handle-backup-failure", async () => {
				await db
					.update(services)
					.set({
						migrationStatus: "failed",
						migrationError: backupFailure.error,
					})
					.where(eq(services.id, serviceId));
			});
			return { status: "failed", reason: "backup_failed" };
		}

		const restoreWorkItemIds = await step.run("restore-volumes", async () => {
			await db
				.update(services)
				.set({ migrationStatus: "restoring" })
				.where(eq(services.id, serviceId));

			const backups = await db
				.select()
				.from(volumeBackups)
				.where(
					and(
						inArray(volumeBackups.id, backupIds),
						eq(volumeBackups.status, "completed"),
					),
				);
			if (backups.length !== backupIds.length) {
				throw new Error("Migration backup data is incomplete");
			}

			const workItemIds: string[] = [];
			for (const backup of backups) {
				if (!backup.storagePath || !backup.checksum) {
					throw new Error("Migration backup data is incomplete");
				}

				const workItemId = await enqueueWork(targetServerId, "restore_volume", {
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
				workItemIds.push(workItemId);
			}
			return workItemIds;
		});

		const restoreCorrelations =
			restoreWorkItemIds?.map((workItemId) => ({
				stepId: workItemId,
				if: `async.data.workItemId == "${workItemId}"`,
			})) ??
			backupIds.map((backupId) => ({
				stepId: backupId,
				if: `async.data.backupId == "${backupId}" && async.data.serviceId == "${serviceId}"`,
			}));
		const restoreResults = await Promise.all(
			restoreCorrelations.map((correlation) =>
				group.parallel(() =>
					step.waitForEvent(`wait-restore-${correlation.stepId}`, {
						event: inngestEvents.migrationRestoreFinished,
						timeout: "30m",
						if: correlation.if,
					}),
				),
			),
		);

		const restoreTimedOut = restoreResults.some((r) => r === null);
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

		const restoreFailure = restoreResults.find(
			(r) => r?.data.status === "failed",
		);
		if (restoreFailure) {
			await step.run("handle-restore-failure", async () => {
				await db
					.update(services)
					.set({
						migrationStatus: "failed",
						migrationError: restoreFailure.data.error || "Restore failed",
					})
					.where(eq(services.id, serviceId));
			});
			return { status: "failed", reason: "restore_failed" };
		}

		await step.run("deploy-target", async () => {
			await db
				.update(services)
				.set({ migrationStatus: "deploying_target" })
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

			await deployServiceInternal(serviceId, actor, {
				runtimeBaseRevisionId: sourceServiceRevisionId,
			});
		});

		await step.run("finalize-migration", async () => {
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
