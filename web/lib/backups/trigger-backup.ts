import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { getBackupStorageConfig } from "@/db/queries";
import {
	deployments,
	services,
	serviceVolumes,
	volumeBackups,
} from "@/db/schema";
import { detectDatabaseType } from "@/lib/database-utils";
import { enqueueWork } from "@/lib/work-queue";

type TriggerBackupInput = {
	serviceId: string;
	volumeId: string;
	backupTypeOverride?: "volume" | "database";
};

function getDbBackupExtension(image: string): string {
	const imageLower = image.toLowerCase();
	if (imageLower.includes("postgres")) return ".dump";
	if (imageLower.includes("mysql")) return ".sql";
	if (imageLower.includes("mariadb")) return ".sql";
	if (imageLower.includes("mongo")) return ".archive.gz";
	if (imageLower.includes("redis")) return ".rdb";
	return ".backup";
}

export async function triggerBackup({
	serviceId,
	volumeId,
	backupTypeOverride,
}: TriggerBackupInput) {
	const storageConfig = await getBackupStorageConfig();
	if (!storageConfig) {
		throw new Error("Backup storage not configured");
	}

	const volume = await db
		.select()
		.from(serviceVolumes)
		.where(eq(serviceVolumes.id, volumeId))
		.then((r) => r[0]);

	if (!volume) {
		throw new Error("Volume not found");
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

	if (!deployment || !deployment.serverId) {
		throw new Error("No running deployment found for this service");
	}

	if (!deployment.containerId) {
		throw new Error("Deployment is missing container ID");
	}

	const backupType =
		backupTypeOverride ??
		(detectDatabaseType(service.image) ? "database" : "volume");
	const backupId = randomUUID();
	const fileExtension =
		backupType === "database" ? getDbBackupExtension(service.image) : ".tar.gz";
	const storagePath = `backups/${serviceId}/${volume.name}/${backupId}${fileExtension}`;

	await db.insert(volumeBackups).values({
		id: backupId,
		volumeId,
		volumeName: volume.name,
		serviceId,
		serverId: deployment.serverId,
		status: "pending",
		storagePath,
	});

	await enqueueWork(deployment.serverId, "backup_volume", {
		backupId,
		serviceId,
		containerId: deployment.containerId,
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

	return { backupId, serverId: deployment.serverId };
}
