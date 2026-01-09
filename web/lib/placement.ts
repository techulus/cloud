import { db } from "@/db";
import { servers } from "@/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { getSetting } from "@/db/queries";
import { SETTING_KEYS } from "@/lib/settings-keys";

export type PlacementResult = { serverId: string; count: number }[];

export async function getHealthyServers(excludeServerIds?: string[]) {
	const allOnlineServers = await db
		.select({
			id: servers.id,
			name: servers.name,
			wireguardIp: servers.wireguardIp,
		})
		.from(servers)
		.where(and(eq(servers.status, "online"), isNotNull(servers.wireguardIp)));

	const excludedFromWorkload = await getSetting<string[]>(
		SETTING_KEYS.SERVERS_EXCLUDED_FROM_WORKLOAD_PLACEMENT,
	);

	const allExcludedIds = new Set([
		...(excludeServerIds ?? []),
		...(excludedFromWorkload ?? []),
	]);

	if (allExcludedIds.size > 0) {
		return allOnlineServers.filter((s) => !allExcludedIds.has(s.id));
	}

	return allOnlineServers;
}

export async function calculateSpreadPlacement(
	totalReplicas: number,
	excludeServerIds?: string[],
): Promise<PlacementResult> {
	const healthyServers = await getHealthyServers(excludeServerIds);

	if (healthyServers.length === 0) {
		throw new Error("No healthy servers available for placement");
	}

	const baseCount = Math.floor(totalReplicas / healthyServers.length);
	const remainder = totalReplicas % healthyServers.length;

	const placements: PlacementResult = [];

	for (let i = 0; i < healthyServers.length; i++) {
		const count = baseCount + (i < remainder ? 1 : 0);
		if (count > 0) {
			placements.push({
				serverId: healthyServers[i].id,
				count,
			});
		}
	}

	return placements;
}
