import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { volumeBackups, services, deployments } from "@/db/schema";
import { getBackupStorageConfig } from "@/db/queries";
import { enqueueWork } from "@/lib/work-queue";
import { inngest } from "../client";

function detectBackupTypeFromPath(storagePath: string): "volume" | "database" {
	if (storagePath.endsWith(".tar.gz")) return "volume";
	if (storagePath.endsWith(".dump")) return "database";
	if (storagePath.endsWith(".sql")) return "database";
	if (storagePath.endsWith(".archive.gz")) return "database";
	if (storagePath.endsWith(".rdb")) return "database";
	return "volume";
}

export const restoreTriggerWorkflow = inngest.createFunction(
	{
		id: "restore-trigger-workflow",
	},
	{ event: "restore/trigger" },
	async ({ event, step }) => {
		const { serviceId, backupId, targetServerId } = event.data;

		const serverId = await step.run("setup-restore", async () => {
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

			const service = await db
				.select()
				.from(services)
				.where(eq(services.id, serviceId))
				.then((r) => r[0]);

			if (!service) {
				throw new Error("Service not found");
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
						eq(deployments.status, "running"),
					),
				)
				.then((r) => r[0]);

			if (!deployment || !deployment.serverId) {
				throw new Error("No running deployment found for this service");
			}

			const resolvedServerId = targetServerId ?? deployment.serverId;
			const backupType = detectBackupTypeFromPath(backup.storagePath);

			await enqueueWork(resolvedServerId, "restore_volume", {
				backupId,
				serviceId,
				containerId: deployment.containerId,
				volumeName: backup.volumeName,
				storagePath: backup.storagePath,
				expectedChecksum: backup.checksum,
				backupType,
				serviceImage: service.image,
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

			return resolvedServerId;
		});

		await step.run("send-restore-started", async () => {
			await inngest.send({
				name: "restore/started",
				data: {
					backupId,
					serviceId,
					serverId,
				},
			});
		});

		return { status: "triggered", backupId };
	},
);
