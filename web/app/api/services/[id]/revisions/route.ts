export const dynamic = "force-dynamic";

import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { rollouts, servers, serviceRevisions, services } from "@/db/schema";
import { requireRequestSession } from "@/lib/api-auth";
import {
	diffServiceRevisionSpecs,
	parseServiceRevisionSpec,
	type ServiceRevisionChangelogItem,
	type ServiceRevisionChangelogResponse,
} from "@/lib/service-revision-changes";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";

const PAGE_SIZE = 25;
const REVISION_CURSOR_TIMESTAMP =
	/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

type RevisionCursor = {
	createdAt: string;
	id: string;
};

function encodeCursor(cursor: RevisionCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): RevisionCursor | null {
	try {
		const decoded = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as unknown;
		if (!decoded || typeof decoded !== "object") return null;

		const cursor = decoded as Partial<RevisionCursor>;
		if (
			typeof cursor.createdAt !== "string" ||
			!REVISION_CURSOR_TIMESTAMP.test(cursor.createdAt) ||
			Number.isNaN(Date.parse(cursor.createdAt)) ||
			typeof cursor.id !== "string" ||
			cursor.id.length === 0 ||
			cursor.id.length > 200
		) {
			return null;
		}

		return { createdAt: cursor.createdAt, id: cursor.id };
	} catch {
		return null;
	}
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const sessionResult = await requireRequestSession(request);
	if (!sessionResult.ok) return sessionResult.response;

	const { id: serviceId } = await params;
	const cursorValue = new URL(request.url).searchParams.get("cursor");
	const cursor = cursorValue ? decodeCursor(cursorValue) : null;
	if (cursorValue && !cursor) {
		return Response.json(
			{ message: "Invalid revision cursor" },
			{ status: 400 },
		);
	}

	const service = await db
		.select({ id: services.id })
		.from(services)
		.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
		.then((rows) => rows[0]);
	if (!service) {
		return Response.json({ message: "Service not found" }, { status: 404 });
	}

	const revisions = await db
		.select({
			id: serviceRevisions.id,
			createdAt: serviceRevisions.createdAt,
			cursorCreatedAt: sql<string>`${serviceRevisions.createdAt}::text`,
			specification: serviceRevisions.specification,
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
		if (
			rollout.serviceRevisionId &&
			!rolloutByRevisionId.has(rollout.serviceRevisionId)
		) {
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
				comparison,
				rollout: rollout ? { id: rollout.id, status: rollout.status } : null,
			};
		},
	);

	const response: ServiceRevisionChangelogResponse = {
		revisions: items,
		nextCursor:
			revisions.length > PAGE_SIZE && pageRevisions.length > 0
				? encodeCursor({
						createdAt: pageRevisions[pageRevisions.length - 1].cursorCreatedAt,
						id: pageRevisions[pageRevisions.length - 1].id,
					})
				: null,
	};

	return Response.json(response);
}
