import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { cron } from "inngest";
import { deleteBackup } from "@/actions/backups";
import { db } from "@/db";
import { getBackupStorageConfig } from "@/db/queries";
import {
	deploymentPorts,
	deployments,
	secrets,
	services,
	serviceVolumes,
	volumeBackups,
} from "@/db/schema";
import { addUtcDays, toDate } from "@/lib/date";
import { deployServiceInternal } from "@/lib/deploy-service";
import { markDeploymentRemoved } from "@/lib/deployment-status";
import { enqueueWork } from "@/lib/work-queue";
import { inngest } from "../client";
import { inngestEvents } from "../events";

const DELETED_SERVICE_RETENTION_DAYS = 7;

async function markServiceDeletionFailed(serviceId: string, error: unknown) {
	await db
		.update(services)
		.set({
			deletionStatus: "failed",
			deletionError:
				error instanceof Error ? error.message : "Service operation failed",
		})
		.where(eq(services.id, serviceId));
}

export const serviceDeletionWorkflow = inngest.createFunction(
	{
		id: "service-deletion-workflow",
		triggers: [inngestEvents.serviceDeletionStarted],
	},
	async ({ event, step, group }) => {
		const { serviceId, reusableBackupIds } = event.data;

		try {
			const setup = await step.run("setup-delete", async () => {
				const storageConfig = await getBackupStorageConfig();
				if (!storageConfig) {
					throw new Error("Backup storage not configured");
				}

				const service = await db
					.select()
					.from(services)
					.where(eq(services.id, serviceId))
					.then((r) => r[0]);

				if (!service) {
					throw new Error("Service not found");
				}

				const volumes = await db
					.select()
					.from(serviceVolumes)
					.where(eq(serviceVolumes.serviceId, serviceId));

				const runningDeployment = await db
					.select({
						id: deployments.id,
						serverId: deployments.serverId,
						containerId: deployments.containerId,
					})
					.from(deployments)
					.where(
						and(
							eq(deployments.serviceId, serviceId),
							inArray(deployments.observedPhase, ["running", "healthy"]),
						),
					)
					.then((r) => r[0]);

				return { service, storageConfig, volumes, runningDeployment };
			});

			let backupIds = [...reusableBackupIds];
			let newBackupIds: string[] = [];

			if (backupIds.length === 0) {
				const createdBackupIds = await step.run(
					"start-delete-backups",
					async () => {
						const deployment = setup.runningDeployment;
						if (!deployment?.containerId) {
							throw new Error("No active deployment found for deletion backup");
						}

						const ids: string[] = [];
						for (const volume of setup.volumes) {
							const backupId = randomUUID();
							ids.push(backupId);
							const storagePath = `deleted-services/${serviceId}/${volume.name}/${backupId}.tar.gz`;

							await db.insert(volumeBackups).values({
								id: backupId,
								volumeId: volume.id,
								volumeName: volume.name,
								serviceId,
								serverId: deployment.serverId,
								status: "pending",
								storagePath,
								isDeletionBackup: true,
							});

							await enqueueWork(deployment.serverId, "backup_volume", {
								backupId,
								serviceId,
								containerId: deployment.containerId,
								volumeName: volume.name,
								storagePath,
								storageConfig: {
									provider: setup.storageConfig.provider,
									bucket: setup.storageConfig.bucket,
									region: setup.storageConfig.region,
									endpoint: setup.storageConfig.endpoint,
									accessKey: setup.storageConfig.accessKey,
									secretKey: setup.storageConfig.secretKey,
								},
							});
						}
						return ids;
					},
				);

				newBackupIds = createdBackupIds;
				backupIds = createdBackupIds;
			}

			if (newBackupIds.length > 0) {
				const backupResults = await Promise.all(
					newBackupIds.map((backupId) =>
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
									`check-delete-backup-${backupId}-before`,
									readBackup,
								);
								if (before?.status === "completed") {
									return { status: "completed" as const };
								}
								if (before?.status === "failed") {
									return {
										status: "failed" as const,
										error: before.errorMessage || "Deletion backup failed",
									};
								}

								const wakeup = await step.waitForEvent(
									`wait-delete-backup-status-${backupId}`,
									{
										event: inngestEvents.resourceStatusChanged,
										timeout: "30m",
										if: `async.data.type == "backup" && async.data.id == "${backupId}"`,
									},
								);

								const after = await step.run(
									`check-delete-backup-${backupId}-after`,
									readBackup,
								);
								if (after?.status === "completed") {
									return { status: "completed" as const };
								}
								if (after?.status === "failed") {
									return {
										status: "failed" as const,
										error: after.errorMessage || "Deletion backup failed",
									};
								}

								return { status: wakeup ? "pending" : "timed_out" } as const;
							},
						),
					),
				);

				const timedOut = backupResults.some((r) => r.status === "timed_out");
				const failed = backupResults.find((r) => r.status === "failed");
				const stillPending = backupResults.some((r) => r.status === "pending");
				if (timedOut || failed || stillPending) {
					await step.run("mark-delete-backup-failed", async () => {
						await db
							.update(services)
							.set({
								deletionStatus: "failed",
								deletionError:
									failed?.error ||
									(stillPending
										? "Deletion backup did not reach a terminal state"
										: "Deletion backup timed out"),
							})
							.where(eq(services.id, serviceId));
					});
					return {
						status: "failed",
						reason: timedOut ? "timeout" : stillPending ? "pending" : "backup",
					};
				}
			}

			await step.run("cleanup-service", async () => {
				await db
					.update(services)
					.set({ deletionStatus: "deleting", deletionError: null })
					.where(eq(services.id, serviceId));

				const allDeployments = await db
					.select()
					.from(deployments)
					.where(eq(deployments.serviceId, serviceId));

				for (const deployment of allDeployments) {
					await db
						.update(deployments)
						.set(markDeploymentRemoved())
						.where(eq(deployments.id, deployment.id));

					if (deployment.containerId) {
						await enqueueWork(deployment.serverId, "stop", {
							deploymentId: deployment.id,
							containerId: deployment.containerId,
						});
					}

					await db
						.delete(deploymentPorts)
						.where(eq(deploymentPorts.deploymentId, deployment.id));
				}

				await db
					.delete(deployments)
					.where(eq(deployments.serviceId, serviceId));

				const cleanupServerId =
					setup.service.lockedServerId ??
					setup.runningDeployment?.serverId ??
					allDeployments.find((deployment) => deployment.serverId)?.serverId;
				if (cleanupServerId && setup.volumes.length > 0) {
					await enqueueWork(cleanupServerId, "cleanup_volumes", { serviceId });
				}

				const deletedAt = new Date();
				await db
					.update(services)
					.set({
						deletedAt,
						purgeAfter: addUtcDays(deletedAt, DELETED_SERVICE_RETENTION_DAYS),
						originalHostname: setup.service.hostname,
						hostname: null,
						deletionStatus: null,
						deletionError: null,
					})
					.where(eq(services.id, serviceId));
			});

			return { status: "deleted", serviceId, backupIds };
		} catch (error) {
			await step.run("mark-unhandled-delete-failed", async () => {
				await markServiceDeletionFailed(serviceId, error);
			});
			return {
				status: "failed",
				reason: error instanceof Error ? error.message : "delete_failed",
			};
		}
	},
);

export const serviceRestoreWorkflow = inngest.createFunction(
	{
		id: "service-restore-workflow",
		triggers: [inngestEvents.serviceRestoreStarted],
	},
	async ({ event, step, group }) => {
		const { serviceId, targetServerId, backupIds } = event.data;

		try {
			const setup = await step.run("setup-restore", async () => {
				const storageConfig = await getBackupStorageConfig();
				if (!storageConfig) {
					throw new Error("Backup storage not configured");
				}

				const service = await db
					.select()
					.from(services)
					.where(eq(services.id, serviceId))
					.then((r) => r[0]);

				if (!service || !service.deletedAt) {
					throw new Error("Deleted service not found");
				}

				const resolvedTargetServerId = targetServerId ?? service.lockedServerId;
				if (!resolvedTargetServerId) {
					throw new Error(
						"Cannot restore because no target server is selected",
					);
				}

				const backups = await db
					.select()
					.from(volumeBackups)
					.where(inArray(volumeBackups.id, backupIds));

				if (backups.length !== backupIds.length) {
					throw new Error(
						"Cannot restore because a retained backup is missing",
					);
				}

				for (const backup of backups) {
					if (!backup.storagePath || !backup.checksum) {
						throw new Error("Backup data is incomplete");
					}
				}

				return {
					storageConfig,
					service,
					targetServerId: resolvedTargetServerId,
					backups,
				};
			});

			await step.run("restore-deletion-backups", async () => {
				for (const backup of setup.backups) {
					await enqueueWork(setup.targetServerId, "restore_volume", {
						backupId: backup.id,
						serviceId,
						volumeName: backup.volumeName,
						storagePath: backup.storagePath,
						expectedChecksum: backup.checksum,
						isMigrationRestore: false,
						storageConfig: {
							provider: setup.storageConfig.provider,
							bucket: setup.storageConfig.bucket,
							region: setup.storageConfig.region,
							endpoint: setup.storageConfig.endpoint,
							accessKey: setup.storageConfig.accessKey,
							secretKey: setup.storageConfig.secretKey,
						},
					});
				}
			});

			const restoreResults = await Promise.all(
				backupIds.map((backupId) =>
					group.parallel(() => {
						const completed = step
							.waitForEvent(`wait-delete-restore-${backupId}`, {
								event: inngestEvents.restoreCompleted,
								timeout: "30m",
								if: `async.data.backupId == "${backupId}" && async.data.serviceId == "${serviceId}"`,
							})
							.then((result) => ({ status: "completed" as const, result }));

						const failed = step
							.waitForEvent(`wait-delete-restore-failed-${backupId}`, {
								event: inngestEvents.restoreFailed,
								timeout: "30m",
								if: `async.data.backupId == "${backupId}" && async.data.serviceId == "${serviceId}"`,
							})
							.then((result) => ({ status: "failed" as const, result }));

						return Promise.race([completed, failed]);
					}),
				),
			);

			const failed = restoreResults.find((r) => r.status === "failed");
			const timedOut = restoreResults.some((r) => r.result === null);
			if (failed || timedOut) {
				await step.run("mark-restore-failed", async () => {
					await db
						.update(services)
						.set({
							deletionStatus: "failed",
							deletionError:
								failed?.result?.data.error || "Volume restore timed out",
						})
						.where(eq(services.id, serviceId));
				});
				return { status: "failed", reason: failed ? "restore" : "timeout" };
			}

			const deployResult = await step.run(
				"start-restored-deployment",
				async () => {
					await db
						.update(services)
						.set({
							deletedAt: null,
							purgeAfter: null,
							hostname: setup.service.originalHostname,
							originalHostname: null,
							deletionStatus: "restoring",
							deletionError: null,
							lockedServerId: setup.targetServerId,
						})
						.where(eq(services.id, serviceId));

					try {
						const result = await deployServiceInternal(serviceId);
						if (!("rolloutId" in result) || !result.rolloutId) {
							throw new Error("Restore could not start a deployment");
						}
						return result;
					} catch (error) {
						await db
							.update(services)
							.set({
								deletedAt: toDate(setup.service.deletedAt),
								purgeAfter: toDate(setup.service.purgeAfter),
								hostname: null,
								originalHostname: setup.service.originalHostname,
								deletionStatus: "failed",
								deletionError:
									error instanceof Error
										? error.message
										: "Restore deployment failed",
							})
							.where(eq(services.id, serviceId));
						throw error;
					}
				},
			);

			await group.parallel(() =>
				step.waitForEvent("wait-restore-deployment-status", {
					event: inngestEvents.resourceStatusChanged,
					timeout: "15m",
					if: `async.data.type == "deployment" && async.data.parentType == "rollout" && async.data.parentId == "${deployResult.rolloutId}"`,
				}),
			);

			const restoredDeployments = await step.run(
				"check-restore-deployment-status",
				async () => {
					return db
						.select({
							observedPhase: deployments.observedPhase,
							failedStage: deployments.failedStage,
						})
						.from(deployments)
						.where(
							and(
								eq(deployments.rolloutId, deployResult.rolloutId),
								eq(deployments.serviceId, serviceId),
							),
						);
				},
			);

			const healthyDeployment = restoredDeployments.find(
				(deployment) =>
					deployment.observedPhase === "healthy" ||
					deployment.observedPhase === "running",
			);
			const failedDeployment = restoredDeployments.find(
				(deployment) => deployment.observedPhase === "failed",
			);

			if (!healthyDeployment || failedDeployment) {
				await step.run("mark-restore-deployment-failed", async () => {
					await db
						.update(services)
						.set({
							deletedAt: toDate(setup.service.deletedAt),
							purgeAfter: toDate(setup.service.purgeAfter),
							hostname: null,
							originalHostname: setup.service.originalHostname,
							deletionStatus: "failed",
							deletionError:
								failedDeployment?.failedStage ||
								"Restore deployment did not become healthy",
						})
						.where(eq(services.id, serviceId));
				});
				return { status: "failed", reason: "deployment" };
			}

			await step.run("mark-restore-complete", async () => {
				await db
					.update(volumeBackups)
					.set({ isDeletionBackup: false })
					.where(
						and(
							eq(volumeBackups.serviceId, serviceId),
							eq(volumeBackups.isDeletionBackup, true),
						),
					);

				await db
					.update(services)
					.set({ deletionStatus: null, deletionError: null })
					.where(eq(services.id, serviceId));
			});

			return { status: "restored", serviceId };
		} catch (error) {
			await step.run("mark-unhandled-restore-failed", async () => {
				await markServiceDeletionFailed(serviceId, error);
			});
			return {
				status: "failed",
				reason: error instanceof Error ? error.message : "restore_failed",
			};
		}
	},
);

export const expiredDeletedServicesPurge = inngest.createFunction(
	{
		id: "cron-expired-deleted-services-purge",
		triggers: [cron("0 4 * * *")],
		singleton: { mode: "skip" },
	},
	async ({ step }) => {
		await step.run("purge-expired-deleted-services", async () => {
			const expiredServices = await db
				.select({ id: services.id })
				.from(services)
				.where(
					and(
						isNotNull(services.deletedAt),
						isNotNull(services.purgeAfter),
						or(
							isNull(services.deletionStatus),
							eq(services.deletionStatus, "failed"),
						),
						lte(services.purgeAfter, new Date()),
					),
				);

			for (const service of expiredServices) {
				const backups = await db
					.select({ id: volumeBackups.id })
					.from(volumeBackups)
					.where(eq(volumeBackups.serviceId, service.id));

				for (const backup of backups) {
					await deleteBackup(backup.id, { revalidate: false });
				}

				await db.delete(secrets).where(eq(secrets.serviceId, service.id));
				await db.delete(services).where(eq(services.id, service.id));
			}
		});
	},
);
