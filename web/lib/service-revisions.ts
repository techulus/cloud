import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
	rollouts,
	secrets,
	servicePorts,
	serviceReplicas,
	serviceRevisions,
	services,
	serviceVolumes,
} from "@/db/schema";
import {
	buildServiceRevisionSpec,
	SERVICE_REVISION_SCHEMA_VERSION,
} from "@/lib/service-revision-spec";

export async function createRolloutWithServiceRevision(serviceId: string) {
	return db.transaction(
		async (tx) => {
			const service = await tx
				.select()
				.from(services)
				.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
				.then((rows) => rows[0]);

			if (!service) {
				throw new Error("Service not found");
			}

			const placements = await tx
				.select({
					serverId: serviceReplicas.serverId,
					count: serviceReplicas.count,
				})
				.from(serviceReplicas)
				.where(eq(serviceReplicas.serviceId, serviceId));
			const ports = await tx
				.select()
				.from(servicePorts)
				.where(eq(servicePorts.serviceId, serviceId));
			const revisionSecrets = await tx
				.select({
					key: secrets.key,
					encryptedValue: secrets.encryptedValue,
					updatedAt: secrets.updatedAt,
				})
				.from(secrets)
				.where(eq(secrets.serviceId, serviceId));
			const volumes = await tx
				.select({
					name: serviceVolumes.name,
					containerPath: serviceVolumes.containerPath,
				})
				.from(serviceVolumes)
				.where(eq(serviceVolumes.serviceId, serviceId));

			const specification = buildServiceRevisionSpec({
				service,
				placements,
				ports,
				secrets: revisionSecrets,
				volumes,
			});
			const revision = await tx
				.insert(serviceRevisions)
				.values({ id: randomUUID(), serviceId, specification })
				.returning()
				.then((rows) => rows[0]);
			if (!revision) {
				throw new Error("Failed to create service revision");
			}

			const rolloutId = randomUUID();
			await tx.insert(rollouts).values({
				id: rolloutId,
				serviceId,
				serviceRevisionId: revision.id,
				status: "queued",
				currentStage: "queued",
			});

			return { rolloutId, revision };
		},
		{ isolationLevel: "repeatable read" },
	);
}

export async function getRolloutServiceRevision(rolloutId: string) {
	const result = await db
		.select({
			revision: serviceRevisions,
		})
		.from(rollouts)
		.innerJoin(
			serviceRevisions,
			eq(rollouts.serviceRevisionId, serviceRevisions.id),
		)
		.where(eq(rollouts.id, rolloutId))
		.then((rows) => rows[0]);

	if (!result) {
		throw new Error("Rollout revision not found");
	}
	if (
		result.revision.specification.schemaVersion !==
		SERVICE_REVISION_SCHEMA_VERSION
	) {
		throw new Error("Unsupported service revision schema version");
	}

	return result.revision;
}
