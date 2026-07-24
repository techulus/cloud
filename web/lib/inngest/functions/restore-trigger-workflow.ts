import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { getBackupStorageConfig } from "@/db/queries";
import { deployments, volumeBackups } from "@/db/schema";
import { observedReadyPhases } from "@/lib/deployment-status";
import { enqueueWork } from "@/lib/work-queue";
import { inngest } from "../client";
import { inngestEvents } from "../events";

export const restoreTriggerWorkflow = inngest.createFunction(
	{
		id: "restore-trigger-workflow",
		triggers: [inngestEvents.restoreTrigger],
	},
	async ({ event, step }) => {
		const { serviceId, backupId, targetServerId } = event.data;

		const restore = await step.run("setup-restore", async () => {
			const storageConfig = await getBackupStorageConfig();
			if (!storageConfig) {
				throw new Error("Backup storage not configured");
			}

			const backup = await db
				.select()
				.from(volumeBackups)
				.where(eq(volumeBackups.id, backupId))
				.then((r) => r[0]);

			if (!backup) {
				throw new Error("Backup not found");
			}

			if (backup.status !== "completed") {
				throw new Error("Cannot restore incomplete backup");
			}

			if (!backup.storagePath || !backup.checksum) {
				throw new Error("Backup data is incomplete");
			}

			if (!backup.storagePath.endsWith(".tar.gz")) {
				throw new Error("Only generic volume backups can be restored");
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
						inArray(deployments.observedPhase, observedReadyPhases),
					),
				)
				.then((r) => r[0]);

			if (!deployment || !deployment.serverId) {
				throw new Error("No running deployment found for this service");
			}

			const resolvedServerId = targetServerId ?? deployment.serverId;

			const workItemId = await enqueueWork(resolvedServerId, "restore_volume", {
				backupId,
				serviceId,
				containerId:
					resolvedServerId === deployment.serverId
						? deployment.containerId
						: undefined,
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

			return { serverId: resolvedServerId, workItemId };
		});

		await step.run("send-restore-started", async () => {
			await inngest.send(
				inngestEvents.restoreStarted.create({
					workItemId: restore.workItemId,
					backupId,
					serviceId,
					serverId: restore.serverId,
				}),
			);
		});

		return { status: "triggered", backupId };
	},
);
