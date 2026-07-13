import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
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
	hashServiceRevisionSpec,
	SERVICE_REVISION_SCHEMA_VERSION,
	type ServiceRevisionSpec,
} from "@/lib/service-revision-spec";

export type RevisionSourceMetadata = Record<
	string,
	string | number | boolean | null | undefined
>;

function validateRevisionSpec(spec: ServiceRevisionSpec) {
	const totalReplicas = spec.placements.reduce(
		(sum, placement) => sum + placement.count,
		0,
	);

	if (totalReplicas < 1) {
		throw new Error("At least one replica is required");
	}
	if (totalReplicas > 10) {
		throw new Error("Maximum 10 replicas allowed");
	}
	if (spec.stateful && totalReplicas !== 1) {
		throw new Error("Stateful services can only have exactly 1 replica");
	}
	if (spec.stateful && spec.placements.length !== 1) {
		throw new Error("Stateful services must be deployed to exactly one server");
	}
}

function compactSourceMetadata(metadata: RevisionSourceMetadata) {
	return Object.fromEntries(
		Object.entries(metadata).filter((entry) => entry[1] !== undefined),
	) as Record<string, string | number | boolean | null>;
}

export async function createRolloutWithServiceRevision(
	serviceId: string,
	sourceMetadata: RevisionSourceMetadata = {},
) {
	return db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);

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
		validateRevisionSpec(specification);

		const contentHash = hashServiceRevisionSpec(specification);
		let revision = await tx
			.select()
			.from(serviceRevisions)
			.where(
				and(
					eq(serviceRevisions.serviceId, serviceId),
					eq(serviceRevisions.contentHash, contentHash),
				),
			)
			.then((rows) => rows[0]);

		if (!revision) {
			const [{ nextRevisionNumber }] = await tx
				.select({
					nextRevisionNumber: sql<number>`coalesce(max(${serviceRevisions.revisionNumber}), 0) + 1`,
				})
				.from(serviceRevisions)
				.where(eq(serviceRevisions.serviceId, serviceId));

			revision = await tx
				.insert(serviceRevisions)
				.values({
					id: randomUUID(),
					serviceId,
					revisionNumber: nextRevisionNumber,
					schemaVersion: SERVICE_REVISION_SCHEMA_VERSION,
					specification,
					contentHash,
					sourceMetadata: compactSourceMetadata({
						sourceType: service.sourceType,
						...sourceMetadata,
					}),
				})
				.returning()
				.then((rows) => rows[0]);
		}
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
	});
}

export async function getRolloutServiceRevision(rolloutId: string) {
	const result = await db
		.select({
			rolloutServiceId: rollouts.serviceId,
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
	if (result.rolloutServiceId !== result.revision.serviceId) {
		throw new Error("Rollout revision does not belong to service");
	}
	if (
		result.revision.schemaVersion !== SERVICE_REVISION_SCHEMA_VERSION ||
		result.revision.specification.schemaVersion !==
			SERVICE_REVISION_SCHEMA_VERSION
	) {
		throw new Error("Unsupported service revision schema version");
	}

	return result.revision;
}
