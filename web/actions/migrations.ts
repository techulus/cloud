"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { services, serviceVolumes, deployments } from "@/db/schema";
import { getBackupStorageConfig } from "@/db/queries";
import { detectDatabaseType } from "@/lib/database-utils";
import { revalidatePath } from "next/cache";
import { inngest } from "@/lib/inngest/client";

export async function startMigration(
	serviceId: string,
	targetServerId: string,
) {
	const storageConfig = await getBackupStorageConfig();
	if (!storageConfig) {
		throw new Error(
			"Backup storage not configured. Configure it in Settings first.",
		);
	}

	const service = await db
		.select()
		.from(services)
		.where(eq(services.id, serviceId))
		.then((r) => r[0]);

	if (!service) {
		throw new Error("Service not found");
	}

	if (!service.stateful) {
		throw new Error("Only stateful services can be migrated");
	}

	if (service.migrationStatus) {
		throw new Error("Migration already in progress");
	}

	const volumes = await db
		.select()
		.from(serviceVolumes)
		.where(eq(serviceVolumes.serviceId, serviceId));

	if (volumes.length === 0) {
		throw new Error("No volumes found for this service");
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

	if (!deployment?.serverId) {
		throw new Error("No running deployment found");
	}

	if (!deployment.containerId) {
		throw new Error("Deployment is missing container ID");
	}

	if (deployment.serverId === targetServerId) {
		throw new Error("Service is already running on the target server");
	}

	const dbType = detectDatabaseType(service.image);
	const isDatabase = Boolean(dbType);

	await db
		.update(services)
		.set({
			migrationStatus: "backing_up",
			migrationTargetServerId: targetServerId,
			migrationBackupId: null,
			migrationError: null,
		})
		.where(eq(services.id, serviceId));

	await inngest.send({
		name: "migration/started",
		data: {
			serviceId,
			targetServerId,
			sourceServerId: deployment.serverId,
			sourceDeploymentId: deployment.id,
			sourceContainerId: deployment.containerId,
			volumes: volumes.map((v) => ({ id: v.id, name: v.name })),
			isDatabase,
		},
	});

	revalidatePath(`/dashboard/projects`);
	return { success: true };
}

export async function cancelMigration(serviceId: string) {
	await inngest.send({
		name: "migration/cancelled",
		data: { serviceId },
	});

	await db
		.update(services)
		.set({
			migrationStatus: null,
			migrationTargetServerId: null,
			migrationBackupId: null,
			migrationError: null,
		})
		.where(eq(services.id, serviceId));

	revalidatePath(`/dashboard/projects`);
	return { success: true };
}

export async function getMigrationStatus(serviceId: string) {
	const service = await db
		.select({
			migrationStatus: services.migrationStatus,
			migrationError: services.migrationError,
		})
		.from(services)
		.where(eq(services.id, serviceId))
		.then((r) => r[0]);

	return service ?? null;
}
