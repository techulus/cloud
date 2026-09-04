import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { serviceRevisions, workQueue } from "@/db/schema";
import { deleteGarProtectionTag } from "@/lib/google-artifact-registry";
import { reportServerError } from "@/lib/server-errors";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";

type GarRetentionTransaction = Parameters<
	Parameters<typeof db.transaction>[0]
>[0];

const DAILY_BATCH_SIZE = 100;

type RevisionArtifact = {
	id: string;
	serviceId: string;
	specification: unknown;
	artifactDeletedAt: Date | null;
};

type ArtifactCandidate = RevisionArtifact & { image: string };

export async function prepareGarPackageDeletion(
	tx: GarRetentionTransaction,
	serviceId: string,
): Promise<boolean> {
	await tx
		.update(workQueue)
		.set({ status: "failed" })
		.where(
			and(
				eq(workQueue.type, "create_manifest"),
				eq(workQueue.status, "pending"),
				sql`${workQueue.payload}::jsonb ->> 'serviceId' = ${serviceId}`,
			),
		);
	const processing = await tx
		.select({ id: workQueue.id })
		.from(workQueue)
		.where(
			and(
				eq(workQueue.type, "create_manifest"),
				eq(workQueue.status, "processing"),
				sql`${workQueue.payload}::jsonb ->> 'serviceId' = ${serviceId}`,
			),
		)
		.limit(1);
	return processing.length === 0;
}

async function releaseArtifactProtection(revision: RevisionArtifact) {
	if (revision.artifactDeletedAt) return false;
	const specification = parseServiceRevisionSpec(revision.specification);
	if (specification.source.type !== "github") return false;
	await deleteGarProtectionTag(specification.image);
	return true;
}

export async function releaseGarRevisionProtection(revision: RevisionArtifact) {
	if (!(await releaseArtifactProtection(revision))) return false;
	const specification = parseServiceRevisionSpec(revision.specification);
	await db
		.update(serviceRevisions)
		.set({ artifactDeletedAt: new Date() })
		.where(
			and(
				eq(serviceRevisions.serviceId, revision.serviceId),
				sql`${serviceRevisions.specification} ->> 'image' = ${specification.image}`,
				isNull(serviceRevisions.artifactDeletedAt),
			),
		);
	return true;
}

export async function releaseGarProtectionDaily() {
	const result = await db.execute<ArtifactCandidate>(sql`
		with completed_ranked as (
			select r.service_id, sr.specification ->> 'image' as image,
				row_number() over (partition by r.service_id order by r.completed_at desc nulls last, r.created_at desc, r.id desc) as rank
			from rollouts r join service_revisions sr on sr.id = r.service_revision_id
			where r.status = 'completed'
		)
		select min(sr.id) as id, sr.service_id as "serviceId",
			min(sr.specification::text)::jsonb as specification,
			null::timestamptz as "artifactDeletedAt", sr.specification ->> 'image' as image
		from service_revisions sr
		join services s on s.id = sr.service_id and s.deleted_at is null
		where sr.artifact_deleted_at is null
			and sr.specification -> 'source' ->> 'type' = 'github'
			and exists (select 1 from rollouts r join service_revisions x on x.id = r.service_revision_id
				where x.service_id = sr.service_id and x.specification ->> 'image' = sr.specification ->> 'image'
					and r.status in ('failed','rolled_back','completed'))
			and not exists (select 1 from rollouts r join service_revisions x on x.id = r.service_revision_id
				where x.service_id = sr.service_id and x.specification ->> 'image' = sr.specification ->> 'image'
					and r.status in ('queued','in_progress'))
			and not exists (select 1 from deployments d join service_revisions x on x.id = d.service_revision_id
				where x.service_id = sr.service_id and x.specification ->> 'image' = sr.specification ->> 'image'
					and d.runtime_desired_state <> 'removed')
			and not exists (select 1 from completed_ranked cr where cr.service_id = sr.service_id
				and cr.image = sr.specification ->> 'image' and cr.rank <= 10)
		group by sr.service_id, sr.specification ->> 'image'
		order by min(sr.id) limit ${DAILY_BATCH_SIZE}
	`);
	for (const candidate of result.rows) {
		try {
			await db.transaction(async (tx) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtext(${candidate.serviceId}))`,
				);
				const eligible = await tx.execute<RevisionArtifact>(sql`
					with completed_ranked as (
						select sr.specification ->> 'image' as image,
							row_number() over (order by r.completed_at desc nulls last, r.created_at desc, r.id desc) as rank
						from rollouts r join service_revisions sr on sr.id = r.service_revision_id
						where r.service_id = ${candidate.serviceId} and r.status = 'completed'
					), artifact_revisions as (
						select sr.* from service_revisions sr join services s on s.id = sr.service_id
						where sr.service_id = ${candidate.serviceId}
							and sr.specification ->> 'image' = ${candidate.image}
							and s.deleted_at is null
					), eligibility as (
						select exists (select 1 from rollouts r join artifact_revisions x on x.id = r.service_revision_id where r.status in ('failed','rolled_back','completed'))
							and not exists (select 1 from rollouts r join artifact_revisions x on x.id = r.service_revision_id where r.status in ('queued','in_progress'))
							and not exists (select 1 from deployments d join artifact_revisions x on x.id = d.service_revision_id where d.runtime_desired_state <> 'removed')
							and not exists (select 1 from completed_ranked where image = ${candidate.image} and rank <= 10) as eligible
					), representative as (
						select e.* from artifact_revisions e cross join eligibility
						where eligibility.eligible and e.artifact_deleted_at is null
							and e.specification -> 'source' ->> 'type' = 'github'
						order by e.id limit 1
					)
					select r.id, r.service_id as "serviceId", r.specification,
						r.artifact_deleted_at as "artifactDeletedAt"
					from representative r
				`);
				const revision = eligible.rows[0];
				if (!revision) return;
				await releaseArtifactProtection(revision);
				await tx.execute(sql`update service_revisions set artifact_deleted_at = now()
					where service_id = ${candidate.serviceId} and specification ->> 'image' = ${candidate.image}
						and artifact_deleted_at is null`);
			});
		} catch (error) {
			reportServerError(error, "gar.protection.release", {
				tags: {
					revisionId: candidate.id,
					serviceId: candidate.serviceId,
				},
			});
			console.error(
				`[gar-retention] failed to release artifact ${candidate.id}`,
				error,
			);
		}
	}
	return result.rows.length;
}
