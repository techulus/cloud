import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { getBackupStorageConfig } from "@/db/queries";
import {
	deployments,
	serviceRevisions,
	services,
	serviceVolumes,
} from "@/db/schema";
import { observedReadyPhases } from "@/lib/deployment-status";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import type { ServiceRevisionActor } from "@/lib/service-revision-actor";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";

export async function startMigrationInternal(
	serviceId: string,
	targetServerId: string,
	actor: ServiceRevisionActor | null,
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
			serviceRevisionId: deployments.serviceRevisionId,
		})
		.from(deployments)
		.where(
			and(
				eq(deployments.serviceId, serviceId),
				eq(deployments.trafficState, "active"),
				inArray(deployments.observedPhase, observedReadyPhases),
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
	if (service.sourceType === "github") {
		const baseRevision = await db
			.select({ specification: serviceRevisions.specification })
			.from(serviceRevisions)
			.where(
				and(
					eq(serviceRevisions.id, deployment.serviceRevisionId),
					eq(serviceRevisions.serviceId, serviceId),
				),
			)
			.then((rows) => rows[0]);
		if (!baseRevision)
			throw new Error("Runtime base service revision not found");
		let specification: ReturnType<typeof parseServiceRevisionSpec>;
		try {
			specification = parseServiceRevisionSpec(baseRevision.specification);
		} catch {
			throw new Error("GitHub runtime base revision is invalid");
		}
		if (specification.source.type !== "github") {
			throw new Error("GitHub runtime base revision is not a GitHub build");
		}
	}

	await db
		.update(services)
		.set({
			migrationStatus: "backing_up",
			migrationTargetServerId: targetServerId,
			migrationBackupId: null,
			migrationError: null,
		})
		.where(eq(services.id, serviceId));

	await inngest.send(
		inngestEvents.migrationStarted.create({
			serviceId,
			targetServerId,
			sourceServerId: deployment.serverId,
			sourceDeploymentId: deployment.id,
			sourceServiceRevisionId: deployment.serviceRevisionId,
			sourceContainerId: deployment.containerId,
			volumes: volumes.map((v) => ({ id: v.id, name: v.name })),
			actor,
		}),
	);

	return { success: true };
}
