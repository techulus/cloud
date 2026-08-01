import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { builds, serviceRevisions, workQueue } from "@/db/schema";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";

type RegistryCleanupTransaction = Parameters<
	Parameters<typeof db.transaction>[0]
>[0];

const MANIFEST_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const DAILY_BATCH_SIZE = 100;

type RevisionArtifact = {
	id: string;
	serviceId: string;
	specification: unknown;
	artifactDeletedAt: Date | null;
};

type ArtifactCandidate = RevisionArtifact & { image: string };

export async function prepareRegistryArtifactCleanup(
	tx: RegistryCleanupTransaction,
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

function registryConfig() {
	const rawUrl = process.env.REGISTRY_URL;
	const rawHost = process.env.REGISTRY_HOST;
	const username = process.env.REGISTRY_USERNAME;
	const password = process.env.REGISTRY_PASSWORD;
	if (!rawUrl || !rawHost || !username || !password) {
		throw new Error("Registry retention requires registry configuration");
	}
	const url = new URL(
		/^[a-z][a-z\d+.-]*:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`,
	);
	const hostUrl = new URL(
		/^[a-z][a-z\d+.-]*:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`,
	);
	if (hostUrl.pathname !== "/" || hostUrl.search || hostUrl.hash) {
		throw new Error("REGISTRY_HOST must contain only a registry authority");
	}
	return {
		url,
		host: hostUrl.host.toLowerCase(),
		authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
	};
}

function managedReference(image: string, registryHost: string) {
	const withoutScheme = image.replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
	const slash = withoutScheme.indexOf("/");
	if (
		slash <= 0 ||
		withoutScheme.slice(0, slash).toLowerCase() !== registryHost
	) {
		throw new Error("Malformed or unmanaged registry image reference");
	}
	const pathAndReference = withoutScheme.slice(slash + 1);
	const digestAt = pathAndReference.lastIndexOf("@");
	const colon = pathAndReference.lastIndexOf(":");
	const separator = digestAt >= 0 ? digestAt : colon;
	if (
		separator <= 0 ||
		(colon < pathAndReference.lastIndexOf("/") && digestAt < 0)
	) {
		throw new Error("Malformed or unmanaged registry image reference");
	}
	const repository = pathAndReference.slice(0, separator);
	const reference = pathAndReference.slice(separator + 1);
	if (
		!repository ||
		repository.split("/").some((part) => !part) ||
		!reference
	) {
		throw new Error("Malformed or unmanaged registry image reference");
	}
	return { repository, reference, isDigest: digestAt >= 0 };
}

function manifestUrl(registryUrl: URL, repository: string, reference: string) {
	const base = registryUrl.toString().replace(/\/$/, "");
	const encodedRepository = repository
		.split("/")
		.map(encodeURIComponent)
		.join("/");
	return `${base}/v2/${encodedRepository}/manifests/${encodeURIComponent(reference)}`;
}

async function deleteTag(
	registryUrl: URL,
	authorization: string,
	repository: string,
	tag: string,
) {
	// Registry 3.1.1 supports exact-tag deletion. Resolving and deleting the
	// digest would also remove retained aliases that point to the same manifest.
	const response = await fetch(manifestUrl(registryUrl, repository, tag), {
		method: "DELETE",
		headers: { Accept: MANIFEST_ACCEPT, Authorization: authorization },
	});
	if (response.status !== 404 && !response.ok) {
		throw new Error(`Registry manifest DELETE failed (${response.status})`);
	}
}

async function deleteArtifactReferences(
	revision: RevisionArtifact,
	completedBuilds: Array<{ imageUri: string | null }>,
) {
	if (revision.artifactDeletedAt) return false;
	const specification = parseServiceRevisionSpec(revision.specification);
	if (specification.source.type !== "github") return false;
	const config = registryConfig();
	const finalReference = managedReference(specification.image, config.host);
	if (finalReference.isDigest) {
		throw new Error("Managed final image reference must use a tag");
	}
	const references = [finalReference];
	for (const build of completedBuilds) {
		if (build.imageUri && !build.imageUri.includes("@")) {
			const reference = managedReference(build.imageUri, config.host);
			if (!reference.isDigest) references.push(reference);
		}
	}
	const unique = references.filter(
		(item, index) =>
			references.findIndex(
				(other) =>
					other.repository === item.repository &&
					other.reference === item.reference,
			) === index,
	);
	for (const item of unique) {
		await deleteTag(
			config.url,
			config.authorization,
			item.repository,
			item.reference,
		);
	}
	return true;
}

export async function cleanupRevisionArtifact(revision: RevisionArtifact) {
	const specification = parseServiceRevisionSpec(revision.specification);
	if (revision.artifactDeletedAt || specification.source.type !== "github") {
		return false;
	}
	const revisions = await db
		.select({ id: serviceRevisions.id })
		.from(serviceRevisions)
		.where(
			and(
				eq(serviceRevisions.serviceId, revision.serviceId),
				sql`${serviceRevisions.specification} ->> 'image' = ${specification.image}`,
			),
		);
	const revisionIds = revisions.map(({ id }) => id);
	const completedBuilds = revisionIds.length
		? await db
				.select({ imageUri: builds.imageUri })
				.from(builds)
				.where(
					and(
						inArray(builds.serviceRevisionId, revisionIds),
						eq(builds.serviceId, revision.serviceId),
						eq(builds.status, "completed"),
					),
				)
		: [];
	await deleteArtifactReferences(revision, completedBuilds);
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

export async function cleanupRegistryArtifactsDaily() {
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
				const eligible = await tx.execute<
					RevisionArtifact & { imageUri: string | null }
				>(sql`
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
						r.artifact_deleted_at as "artifactDeletedAt", b.image_uri as "imageUri"
					from representative r
					left join artifact_revisions e on true
					left join builds b on b.service_revision_id = e.id
						and b.service_id = r.service_id and b.status = 'completed'
				`);
				const revision = eligible.rows[0];
				if (!revision) return;
				await deleteArtifactReferences(revision, eligible.rows);
				await tx.execute(sql`update service_revisions set artifact_deleted_at = now()
					where service_id = ${candidate.serviceId} and specification ->> 'image' = ${candidate.image}
						and artifact_deleted_at is null`);
			});
		} catch (error) {
			console.error(
				`[registry-retention] failed to clean artifact ${candidate.id}`,
				error,
			);
		}
	}
	return result.rows.length;
}

export async function cleanupRegistryArtifactsForService(serviceId: string) {
	const revisions = await db
		.select()
		.from(serviceRevisions)
		.where(
			and(
				eq(serviceRevisions.serviceId, serviceId),
				isNull(serviceRevisions.artifactDeletedAt),
			),
		);
	const artifacts = new Map<string, RevisionArtifact>();
	for (const revision of revisions) {
		const specification = parseServiceRevisionSpec(revision.specification);
		if (specification.source.type !== "github") continue;
		const image = specification.image;
		if (!artifacts.has(image)) artifacts.set(image, revision);
	}
	for (const revision of artifacts.values()) {
		await cleanupRevisionArtifact(revision);
	}
}
