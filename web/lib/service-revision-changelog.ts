import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { rollouts, servers, serviceRevisions } from "@/db/schema";
import {
	encodeTimestampCursor,
	type TimestampCursor,
} from "@/lib/public-api-pagination";
import { sanitizeServiceRevisionActor } from "@/lib/service-revision-actor";
import {
	diffServiceRevisionSpecs,
	parseServiceRevisionSpec,
	type ServiceRevisionChangelogItem,
	type ServiceRevisionChangelogResponse,
} from "@/lib/service-revision-changes";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";

const PAGE_SIZE = 25;

/** Load revision history after the caller has authenticated and scoped the service. */
export async function queryServiceRevisionChangelog(
	serviceId: string,
	cursor?: TimestampCursor,
): Promise<ServiceRevisionChangelogResponse> {
	const revisions = await db
		.select({
			id: serviceRevisions.id,
			createdAt: serviceRevisions.createdAt,
			cursorCreatedAt: sql<string>`${serviceRevisions.createdAt}::text`,
			specification: serviceRevisions.specification,
			actor: serviceRevisions.actor,
		})
		.from(serviceRevisions)
		.where(
			and(
				eq(serviceRevisions.serviceId, serviceId),
				cursor
					? or(
							lt(
								serviceRevisions.createdAt,
								sql`${cursor.createdAt}::timestamptz`,
							),
							and(
								eq(
									serviceRevisions.createdAt,
									sql`${cursor.createdAt}::timestamptz`,
								),
								lt(serviceRevisions.id, cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(serviceRevisions.createdAt), desc(serviceRevisions.id))
		.limit(PAGE_SIZE + 1);

	const pageRevisions = revisions.slice(0, PAGE_SIZE);
	const revisionIds = pageRevisions.map((revision) => revision.id);
	const parsedSpecifications = new Map<string, ServiceRevisionSpec>();
	for (const revision of revisions) {
		try {
			parsedSpecifications.set(
				revision.id,
				parseServiceRevisionSpec(revision.specification),
			);
		} catch {
			// Unsupported or malformed historical revisions remain visible.
		}
	}
	const placementServerIds = [
		...new Set(
			[...parsedSpecifications.values()].flatMap((specification) =>
				specification.placements.map((placement) => placement.serverId),
			),
		),
	];
	const [serverRows, revisionRollouts] = await Promise.all([
		placementServerIds.length > 0
			? db
					.select({ id: servers.id, name: servers.name })
					.from(servers)
					.where(inArray(servers.id, placementServerIds))
			: Promise.resolve([]),
		revisionIds.length > 0
			? db
					.select({
						id: rollouts.id,
						serviceRevisionId: rollouts.serviceRevisionId,
						status: rollouts.status,
						createdAt: rollouts.createdAt,
					})
					.from(rollouts)
					.where(
						and(
							eq(rollouts.serviceId, serviceId),
							inArray(rollouts.serviceRevisionId, revisionIds),
						),
					)
					.orderBy(desc(rollouts.createdAt), desc(rollouts.id))
			: Promise.resolve([]),
	]);
	const serverNames = new Map(
		serverRows.map((server) => [server.id, server.name] as const),
	);
	const rolloutByRevisionId = new Map<
		string,
		(typeof revisionRollouts)[number]
	>();
	for (const rollout of revisionRollouts) {
		if (!rolloutByRevisionId.has(rollout.serviceRevisionId)) {
			rolloutByRevisionId.set(rollout.serviceRevisionId, rollout);
		}
	}

	const items: ServiceRevisionChangelogItem[] = pageRevisions.map(
		(revision, index) => {
			const previous = revisions[index + 1];
			let comparison: ServiceRevisionChangelogItem["comparison"];
			if (!previous) {
				comparison = { kind: "initial" };
			} else {
				const currentSpecification = parsedSpecifications.get(revision.id);
				const previousSpecification = parsedSpecifications.get(previous.id);
				if (currentSpecification && previousSpecification) {
					comparison = {
						kind: "changes",
						changes: diffServiceRevisionSpecs(
							previousSpecification,
							currentSpecification,
							serverNames,
						),
					};
				} else {
					comparison = { kind: "unavailable" };
				}
			}

			const rollout = rolloutByRevisionId.get(revision.id);
			return {
				id: revision.id,
				createdAt: revision.createdAt.toISOString(),
				actor: sanitizeServiceRevisionActor(revision.actor),
				comparison,
				rollout: rollout ? { id: rollout.id, status: rollout.status } : null,
			};
		},
	);

	return {
		revisions: items,
		nextCursor:
			revisions.length > PAGE_SIZE && pageRevisions.length > 0
				? encodeTimestampCursor({
						createdAt: pageRevisions[pageRevisions.length - 1].cursorCreatedAt,
						id: pageRevisions[pageRevisions.length - 1].id,
					})
				: null,
	};
}
