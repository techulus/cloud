import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { metricSnapshotToHealthStats } from "@/db/queries";
import { servers, serviceReplicas, settings } from "@/db/schema";
import type { Service } from "@/db/types";
import {
	calculateResourceAwarePlacementFromSnapshot,
	type PlacementResult,
	type PlacementServerSnapshot,
} from "@/lib/placement-planner";
import { SETTING_KEYS } from "@/lib/settings-keys";
import {
	type NodeMetricsSnapshot,
	queryNodeMetricsSnapshots,
} from "@/lib/victoria-metrics";

export type { PlacementResult };

export async function calculateResourceAwarePlacement(
	service: Pick<Service, "id">,
	totalReplicas: number,
	excludeServerIds?: string[],
): Promise<PlacementResult> {
	const [candidateServers, allocatedReplicas, excludedFromWorkload] =
		await Promise.all([
			db
				.select({
					id: servers.id,
					status: servers.status,
					wireguardIp: servers.wireguardIp,
					containerHealth: servers.containerHealth,
				})
				.from(servers)
				.where(
					and(eq(servers.status, "online"), isNotNull(servers.wireguardIp)),
				),
			db
				.select({
					serverId: serviceReplicas.serverId,
					serviceId: serviceReplicas.serviceId,
					count: serviceReplicas.count,
				})
				.from(serviceReplicas),
			getExcludedFromWorkloadPlacement(),
		]);

	const metricsByServer = await queryNodeMetricsSnapshots(
		candidateServers.map((server) => server.id),
	).catch((error) => {
		console.error("[placement] failed to query metrics:", error);
		return new Map<string, NodeMetricsSnapshot>();
	});
	const serversWithMetrics = candidateServers.map((server) => {
		const metrics = metricsByServer.get(server.id);
		return {
			...server,
			healthStats: metricSnapshotToHealthStats(metrics),
		};
	});

	return calculateResourceAwarePlacementFromSnapshot({
		serviceId: service.id,
		totalReplicas,
		servers: serversWithMetrics satisfies PlacementServerSnapshot[],
		existingReplicas: allocatedReplicas,
		excludeServerIds: [...(excludeServerIds ?? []), ...excludedFromWorkload],
	});
}

async function getExcludedFromWorkloadPlacement(): Promise<string[]> {
	const row = await db
		.select({ value: settings.value })
		.from(settings)
		.where(
			eq(settings.key, SETTING_KEYS.SERVERS_EXCLUDED_FROM_WORKLOAD_PLACEMENT),
		)
		.then((result) => result[0]);

	const value = row?.value;
	return Array.isArray(value)
		? value.filter(
				(serverId): serverId is string => typeof serverId === "string",
			)
		: [];
}

export async function replaceServiceReplicaPlacements(
	serviceId: string,
	placements: PlacementResult,
) {
	await db.transaction(async (tx) => {
		await tx
			.delete(serviceReplicas)
			.where(eq(serviceReplicas.serviceId, serviceId));

		if (placements.length === 0) return;

		await tx.insert(serviceReplicas).values(
			placements.map((placement) => ({
				id: randomUUID(),
				serviceId,
				serverId: placement.serverId,
				count: placement.count,
			})),
		);
	});
}
