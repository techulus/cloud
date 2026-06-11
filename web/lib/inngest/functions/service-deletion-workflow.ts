import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
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
import { enqueueWork } from "@/lib/work-queue";
import { inngest } from "../client";
import { inngestEvents } from "../events";

const DELETED_SERVICE_RETENTION_DAYS = 7;

function purgeDateFrom(date: Date) {
	const purgeAfter = new Date(date);
	purgeAfter.setDate(purgeAfter.getDate() + DELETED_SERVICE_RETENTION_DAYS);
	return purgeAfter;
}

export const serviceDeletionWorkflow = inngest.createFunction(
	{
		id: "service-deletion-workflow",
		triggers: [inngestEvents.serviceDeletionStarted],
	},
	async ({ event, step, group }) => {
		const { serviceId, reusableBackupIds } = event.data;

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
						eq(deployments.status, "running"),
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
						throw new Error("No running deployment found for deletion backup");
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
					group.parallel(() => {
						const completed = step
							.waitForEvent(`wait-delete-backup-${backupId}`, {
								event: inngestEvents.backupCompleted,
								timeout: "30m",
								if: `async.data.backupId == "${backupId}" && async.data.serviceId == "${serviceId}"`,
							})
							.then((result) => ({ status: "completed" as const, result }));

						const failed = step
							.waitForEvent(`wait-delete-backup-failed-${backupId}`, {
								event: inngestEvents.backupFailed,
								timeout: "30m",
								if: `async.data.backupId == "${backupId}" && async.data.serviceId == "${serviceId}"`,
							})
							.then((result) => ({ status: "failed" as const, result }));

						return Promise.race([completed, failed]);
					}),
				),
			);

			const timedOut = backupResults.some((r) => r.result === null);
			const failed = backupResults.find((r) => r.status === "failed");
			if (timedOut || failed) {
				await step.run("mark-delete-backup-failed", async () => {
					await db
						.update(services)
						.set({
							deletionStatus: "failed",
							deletionError:
								failed?.result?.data.error || "Deletion backup timed out",
						})
						.where(eq(services.id, serviceId));
				});
				return { status: "failed", reason: timedOut ? "timeout" : "backup" };
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
				if (deployment.status === "running" && deployment.containerId) {
					await db
						.update(deployments)
						.set({ status: "stopping" })
						.where(eq(deployments.id, deployment.id));

					await enqueueWork(deployment.serverId, "stop", {
						deploymentId: deployment.id,
						containerId: deployment.containerId,
					});
				}

				await db
					.delete(deploymentPorts)
					.where(eq(deploymentPorts.deploymentId, deployment.id));
			}

			await db.delete(deployments).where(eq(deployments.serviceId, serviceId));

			const cleanupServerId =
				setup.service.lockedServerId ?? setup.runningDeployment?.serverId;
			if (cleanupServerId && setup.volumes.length > 0) {
				await enqueueWork(cleanupServerId, "cleanup_volumes", { serviceId });
			}

			const deletedAt = new Date();
			await db
				.update(services)
				.set({
					deletedAt,
					purgeAfter: purgeDateFrom(deletedAt),
					originalHostname: setup.service.hostname,
					hostname: null,
					deletionStatus: null,
					deletionError: null,
				})
				.where(eq(services.id, serviceId));
		});

		return { status: "deleted", serviceId, backupIds };
	},
);

export const serviceRestoreWorkflow = inngest.createFunction(
	{
		id: "service-restore-workflow",
		triggers: [inngestEvents.serviceRestoreStarted],
	},
	async ({ event, step, group }) => {
		const { serviceId, rolloutId, backupIds } = event.data;

		const deploymentResult = await group.parallel(() => {
			const healthy = step
				.waitForEvent("wait-restore-deployment-healthy", {
					event: inngestEvents.deploymentHealthy,
					timeout: "15m",
					if: `async.data.rolloutId == "${rolloutId}" && async.data.serviceId == "${serviceId}"`,
				})
				.then((result) => ({ status: "healthy" as const, result }));

			const failed = step
				.waitForEvent("wait-restore-deployment-failed", {
					event: inngestEvents.deploymentFailed,
					timeout: "15m",
					if: `async.data.rolloutId == "${rolloutId}" && async.data.serviceId == "${serviceId}"`,
				})
				.then((result) => ({ status: "failed" as const, result }));

			return Promise.race([healthy, failed]);
		});

		if (!deploymentResult.result || deploymentResult.status === "failed") {
			await step.run("mark-restore-deployment-failed", async () => {
				const errorMessage =
					deploymentResult.status === "failed"
						? deploymentResult.result?.data.reason
						: undefined;
				await db
					.update(services)
					.set({
						deletionStatus: "failed",
						deletionError:
							errorMessage || "Restore deployment did not become healthy",
					})
					.where(eq(services.id, serviceId));
			});
			return { status: "failed", reason: "deployment" };
		}

		await step.run("restore-deletion-backups", async () => {
			const storageConfig = await getBackupStorageConfig();
			if (!storageConfig) {
				throw new Error("Backup storage not configured");
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
						inArray(deployments.status, ["healthy", "running"]),
					),
				)
				.orderBy(desc(deployments.createdAt))
				.limit(1)
				.then((r) => r[0]);

			if (!deployment) {
				throw new Error("No deployment found for restore");
			}

			const backups = await db
				.select()
				.from(volumeBackups)
				.where(inArray(volumeBackups.id, backupIds));

			for (const backup of backups) {
				if (!backup.storagePath || !backup.checksum) {
					throw new Error("Backup data is incomplete");
				}

				await enqueueWork(deployment.serverId, "restore_volume", {
					backupId: backup.id,
					serviceId,
					containerId: deployment.containerId ?? undefined,
					volumeName: backup.volumeName,
					storagePath: backup.storagePath,
					expectedChecksum: backup.checksum,
					isMigrationRestore: false,
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

		await step.run("mark-restore-complete", async () => {
			await db
				.update(services)
				.set({ deletionStatus: null, deletionError: null })
				.where(eq(services.id, serviceId));
		});

		return { status: "restored", serviceId };
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
						lte(services.purgeAfter, new Date()),
					),
				);

			for (const service of expiredServices) {
				const backups = await db
					.select({ id: volumeBackups.id })
					.from(volumeBackups)
					.where(
						and(
							eq(volumeBackups.serviceId, service.id),
							eq(volumeBackups.isDeletionBackup, true),
						),
					);

				for (const backup of backups) {
					await deleteBackup(backup.id, { revalidate: false });
				}

				await db.delete(secrets).where(eq(secrets.serviceId, service.id));
				await db.delete(services).where(eq(services.id, service.id));
			}
		});
	},
);
