import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { servers, serviceReplicas, services, settings } from "@/db/schema";
import type { Service } from "@/db/types";
import {
	calculateResourceAwarePlacementFromSnapshot,
	type PlacementResult,
	type PlacementServerSnapshot,
} from "@/lib/placement-planner";
import { SETTING_KEYS } from "@/lib/settings-keys";

export type { PlacementResult };

export async function calculateResourceAwarePlacement(
	service: Pick<Service, "id" | "resourceCpuLimit" | "resourceMemoryLimitMb">,
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
					resourcesCpu: servers.resourcesCpu,
					resourcesMemory: servers.resourcesMemory,
					resourcesDisk: servers.resourcesDisk,
					healthStats: servers.healthStats,
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
					resourceCpuLimit: services.resourceCpuLimit,
					resourceMemoryLimitMb: services.resourceMemoryLimitMb,
					count: serviceReplicas.count,
				})
				.from(serviceReplicas)
				.innerJoin(services, eq(serviceReplicas.serviceId, services.id)),
			getExcludedFromWorkloadPlacement(),
		]);

	return calculateResourceAwarePlacementFromSnapshot({
		serviceId: service.id,
		totalReplicas,
		resourceCpuLimit: service.resourceCpuLimit,
		resourceMemoryLimitMb: service.resourceMemoryLimitMb,
		servers: candidateServers satisfies PlacementServerSnapshot[],
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
