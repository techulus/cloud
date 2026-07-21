import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
	githubRepos,
	rollouts,
	secrets,
	servicePorts,
	serviceReplicas,
	serviceRevisions,
	services,
	serviceVolumes,
} from "@/db/schema";
import { resolvePersistedSourceFromRows } from "@/lib/public-api";
import type { ServiceRevisionActor } from "@/lib/service-revision-actor";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";
import {
	buildServiceRevisionSpec,
	SERVICE_REVISION_SCHEMA_VERSION,
	type ServiceRevisionSource,
	type ServiceRevisionSpec,
	type ServiceRevisionSpecOverrides,
} from "@/lib/service-revision-spec";

type RevisionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function specificationsMatch(
	actual: unknown,
	expected: ServiceRevisionSpec,
): boolean {
	try {
		return (
			JSON.stringify(parseServiceRevisionSpec(actual)) ===
			JSON.stringify(expected)
		);
	} catch {
		return false;
	}
}

function assertMatchingGitHubBuildRevision(
	revision: typeof serviceRevisions.$inferSelect,
	input: {
		serviceId: string;
		image: string;
		commitSha: string;
		expectedRepository: string;
		expectedBranch: string;
	},
) {
	if (revision.serviceId !== input.serviceId) {
		throw new Error("Service revision idempotency conflict");
	}
	try {
		const specification = parseServiceRevisionSpec(revision.specification);
		if (
			specification.image !== input.image ||
			specification.source.type !== "github" ||
			specification.source.repository !== input.expectedRepository ||
			specification.source.branch !== input.expectedBranch ||
			specification.source.commitSha !== input.commitSha.toLowerCase()
		) {
			throw new Error("Service revision idempotency conflict");
		}
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "Service revision idempotency conflict"
		) {
			throw error;
		}
		throw new Error("Service revision idempotency conflict");
	}
}

function imageRepository(image: string): string {
	const digestIndex = image.indexOf("@");
	if (digestIndex > 0) return image.slice(0, digestIndex);
	const lastColon = image.lastIndexOf(":");
	return lastColon > image.lastIndexOf("/") ? image.slice(0, lastColon) : image;
}

async function createServiceRevisionSnapshot(
	tx: RevisionTransaction,
	input: {
		id: string;
		serviceId: string;
		actor: ServiceRevisionActor | null;
		overrides?: ServiceRevisionSpecOverrides;
	},
) {
	const existing = await tx
		.select()
		.from(serviceRevisions)
		.where(eq(serviceRevisions.id, input.id))
		.then((rows) => rows[0]);
	if (existing) {
		if (existing.serviceId !== input.serviceId) {
			throw new Error("Service revision idempotency conflict");
		}
		return existing;
	}

	const service = await tx
		.select()
		.from(services)
		.where(and(eq(services.id, input.serviceId), isNull(services.deletedAt)))
		.then((rows) => rows[0]);

	if (!service) throw new Error("Service not found");

	const [placements, ports, revisionSecrets, volumes] = await Promise.all([
		tx
			.select({
				serverId: serviceReplicas.serverId,
				count: serviceReplicas.count,
			})
			.from(serviceReplicas)
			.where(eq(serviceReplicas.serviceId, input.serviceId)),
		tx
			.select()
			.from(servicePorts)
			.where(eq(servicePorts.serviceId, input.serviceId)),
		tx
			.select({
				key: secrets.key,
				encryptedValue: secrets.encryptedValue,
				updatedAt: secrets.updatedAt,
			})
			.from(secrets)
			.where(eq(secrets.serviceId, input.serviceId)),
		tx
			.select({
				name: serviceVolumes.name,
				containerPath: serviceVolumes.containerPath,
			})
			.from(serviceVolumes)
			.where(eq(serviceVolumes.serviceId, input.serviceId)),
	]);

	const specification = buildServiceRevisionSpec(
		{
			service,
			placements,
			ports,
			secrets: revisionSecrets,
			volumes,
		},
		input.overrides,
	);
	const revision = await tx
		.insert(serviceRevisions)
		.values({
			id: input.id,
			serviceId: input.serviceId,
			specification,
			actor: input.actor,
		})
		.onConflictDoNothing({ target: serviceRevisions.id })
		.returning()
		.then((rows) => rows[0]);

	if (revision) return revision;

	const conflictingRevision = await tx
		.select()
		.from(serviceRevisions)
		.where(eq(serviceRevisions.id, input.id))
		.then((rows) => rows[0]);
	if (
		!conflictingRevision ||
		conflictingRevision.serviceId !== input.serviceId ||
		!specificationsMatch(conflictingRevision.specification, specification)
	) {
		throw new Error("Service revision idempotency conflict");
	}
	return conflictingRevision;
}

export async function createGitHubBuildServiceRevision(input: {
	id: string;
	serviceId: string;
	image: string;
	commitSha: string;
	expectedRepository: string;
	expectedBranch: string;
	actor: ServiceRevisionActor | null;
}) {
	return db.transaction(
		async (tx) => {
			const existing = await tx
				.select()
				.from(serviceRevisions)
				.where(eq(serviceRevisions.id, input.id))
				.then((rows) => rows[0]);
			if (existing) {
				assertMatchingGitHubBuildRevision(existing, input);
				return existing;
			}

			const [service, repo] = await Promise.all([
				tx
					.select()
					.from(services)
					.where(
						and(eq(services.id, input.serviceId), isNull(services.deletedAt)),
					)
					.then((rows) => rows[0]),
				tx
					.select()
					.from(githubRepos)
					.where(eq(githubRepos.serviceId, input.serviceId))
					.then((rows) => rows[0]),
			]);
			if (!service || service.sourceType !== "github") {
				throw new Error("Active GitHub service not found");
			}

			const currentSource = resolvePersistedSourceFromRows(service, repo);
			if (
				currentSource.type !== "github" ||
				!currentSource.repository ||
				currentSource.repository !== input.expectedRepository ||
				currentSource.branch !== input.expectedBranch
			) {
				throw new Error(
					"GitHub source changed while resolving the build commit",
				);
			}

			const source: ServiceRevisionSource = {
				type: "github",
				repository: currentSource.repository,
				repositoryId: repo?.repoId ?? null,
				branch: currentSource.branch,
				commitSha: input.commitSha,
				rootDir: currentSource.rootDir?.trim() || null,
				authentication: repo
					? {
							type: "github_app",
							installationId: repo.installationId,
						}
					: { type: "anonymous" },
			};

			return createServiceRevisionSnapshot(tx, {
				id: input.id,
				serviceId: input.serviceId,
				actor: input.actor,
				overrides: {
					image: input.image,
					source,
					allowNoPlacements: true,
				},
			});
		},
		{ isolationLevel: "repeatable read" },
	);
}

export async function cloneGitHubBuildServiceRevision(input: {
	serviceId: string;
	sourceRevisionId: string;
	actor: ServiceRevisionActor | null;
}) {
	return db.transaction(async (tx) => {
		const [sourceRevision, activeService] = await Promise.all([
			tx
				.select()
				.from(serviceRevisions)
				.where(
					and(
						eq(serviceRevisions.id, input.sourceRevisionId),
						eq(serviceRevisions.serviceId, input.serviceId),
					),
				)
				.then((rows) => rows[0]),
			tx
				.select({ id: services.id })
				.from(services)
				.where(
					and(eq(services.id, input.serviceId), isNull(services.deletedAt)),
				)
				.then((rows) => rows[0]),
		]);
		if (!sourceRevision) throw new Error("Build service revision not found");
		if (!activeService) throw new Error("Active service not found");

		const sourceSpecification = parseServiceRevisionSpec(
			sourceRevision.specification,
		);
		if (sourceSpecification.source.type !== "github") {
			throw new Error("Build service revision is not a GitHub revision");
		}

		const id = randomUUID();
		const specification: ServiceRevisionSpec = {
			...sourceSpecification,
			image: `${imageRepository(sourceSpecification.image)}:revision-${id}`,
		};
		const revision = await tx
			.insert(serviceRevisions)
			.values({
				id,
				serviceId: input.serviceId,
				specification,
				actor: input.actor,
			})
			.returning()
			.then((rows) => rows[0]);
		if (!revision) throw new Error("Failed to create retry service revision");
		return revision;
	});
}

export async function createRolloutWithServiceRevision(
	serviceId: string,
	actor: ServiceRevisionActor | null,
	runtimeBaseRevisionId?: string,
) {
	return db.transaction(
		async (tx) => {
			let overrides: ServiceRevisionSpecOverrides | undefined;
			if (runtimeBaseRevisionId) {
				const baseRevision = await tx
					.select({ specification: serviceRevisions.specification })
					.from(serviceRevisions)
					.where(
						and(
							eq(serviceRevisions.id, runtimeBaseRevisionId),
							eq(serviceRevisions.serviceId, serviceId),
						),
					)
					.then((rows) => rows[0]);
				if (!baseRevision) {
					throw new Error("Runtime base service revision not found");
				}
				const baseSpecification = parseServiceRevisionSpec(
					baseRevision.specification,
				);
				if (baseSpecification.source.type !== "github") {
					throw new Error("GitHub runtime base revision is not a GitHub build");
				}
				overrides = {
					image: baseSpecification.image,
					source: baseSpecification.source,
				};
			}
			const revision = await createServiceRevisionSnapshot(tx, {
				id: randomUUID(),
				serviceId,
				actor,
				overrides,
			});
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

export async function createRolloutForServiceRevision(
	serviceId: string,
	serviceRevisionId: string,
	artifactImageUri: string,
) {
	return db.transaction(async (tx) => {
		const [revision, activeService] = await Promise.all([
			tx
				.select()
				.from(serviceRevisions)
				.where(
					and(
						eq(serviceRevisions.id, serviceRevisionId),
						eq(serviceRevisions.serviceId, serviceId),
					),
				)
				.then((rows) => rows[0]),
			tx
				.select({ id: services.id })
				.from(services)
				.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
				.then((rows) => rows[0]),
		]);
		if (!revision) throw new Error("Service revision not found");
		if (!activeService) {
			return { rolloutId: null, revision, created: false };
		}

		const specification = parseServiceRevisionSpec(revision.specification);
		if (specification.image !== artifactImageUri) {
			throw new Error("Built artifact does not match the service revision");
		}
		if (!specification.placements.some((placement) => placement.count > 0)) {
			return { rolloutId: null, revision, created: false };
		}

		const rolloutId = randomUUID();
		const created = await tx
			.insert(rollouts)
			.values({
				id: rolloutId,
				serviceId,
				serviceRevisionId,
				status: "queued",
				currentStage: "queued",
			})
			.onConflictDoNothing({ target: rollouts.serviceRevisionId })
			.returning({ id: rollouts.id })
			.then((rows) => rows[0]);
		if (created) return { rolloutId: created.id, revision, created: true };

		const existing = await tx
			.select({ id: rollouts.id })
			.from(rollouts)
			.where(eq(rollouts.serviceRevisionId, serviceRevisionId))
			.then((rows) => rows[0]);
		if (!existing) throw new Error("Failed to create rollout");
		return { rolloutId: existing.id, revision, created: false };
	});
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

	if (!result) throw new Error("Rollout revision not found");
	if (
		result.revision.specification.schemaVersion !==
		SERVICE_REVISION_SCHEMA_VERSION
	) {
		throw new Error("Unsupported service revision schema version");
	}

	return result.revision;
}
