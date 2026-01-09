import { db } from "@/db";
import { deployments, servers, services, serviceReplicas } from "@/db/schema";
import { and, eq, inArray, lt, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { calculateSpreadPlacement } from "@/lib/placement";
import { deployService } from "@/actions/projects";

const STALE_THRESHOLD_MS = 120_000; // 2 minutes

export async function triggerRecoveryForOfflineServers(
	offlineServerIds: string[],
): Promise<void> {
	if (offlineServerIds.length === 0) return;

	const activeStatuses = ["running", "healthy", "starting"] as const;

	const affectedDeployments = await db
		.select({
			deploymentId: deployments.id,
			serviceId: deployments.serviceId,
			serverId: deployments.serverId,
			autoPlace: services.autoPlace,
			stateful: services.stateful,
			replicas: services.replicas,
		})
		.from(deployments)
		.innerJoin(services, eq(deployments.serviceId, services.id))
		.where(
			and(
				inArray(deployments.serverId, offlineServerIds),
				inArray(deployments.status, activeStatuses),
				eq(services.autoPlace, true),
				eq(services.stateful, false),
			),
		);

	if (affectedDeployments.length === 0) {
		console.log(
			"[scheduler] no auto-placed services affected by server failure",
		);
		return;
	}

	const serviceIds = [...new Set(affectedDeployments.map((d) => d.serviceId))];
	console.log(
		`[scheduler] recovering ${serviceIds.length} services affected by server failure`,
	);

	for (const serviceId of serviceIds) {
		try {
			const service = affectedDeployments.find(
				(d) => d.serviceId === serviceId,
			);
			if (!service) continue;

			console.log(`[scheduler] recovering service ${serviceId}`);

			const newPlacements = await calculateSpreadPlacement(
				service.replicas,
				offlineServerIds,
			);

			await db
				.delete(serviceReplicas)
				.where(eq(serviceReplicas.serviceId, serviceId));

			for (const placement of newPlacements) {
				await db.insert(serviceReplicas).values({
					id: randomUUID(),
					serviceId,
					serverId: placement.serverId,
					count: placement.count,
				});
			}

			await deployService(serviceId);

			console.log(`[scheduler] service ${serviceId} recovery triggered`);
		} catch (error) {
			console.error(
				`[scheduler] failed to recover service ${serviceId}:`,
				error,
			);
		}
	}
}

export async function checkAndRecoverStaleServers(
	excludeServerId?: string,
): Promise<void> {
	const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

	const conditions = [
		eq(servers.status, "online"),
		lt(servers.lastHeartbeat, staleThreshold),
	];

	if (excludeServerId) {
		conditions.push(ne(servers.id, excludeServerId));
	}

	const markedOffline = await db
		.update(servers)
		.set({ status: "offline" })
		.where(and(...conditions))
		.returning({ id: servers.id });

	if (markedOffline.length === 0) return;

	const offlineIds = markedOffline.map((s) => s.id);
	console.log(
		`[scheduler] marked ${offlineIds.length} stale servers offline, triggering recovery`,
	);

	triggerRecoveryForOfflineServers(offlineIds).catch((error) => {
		console.error("[scheduler] recovery failed:", error);
	});
}
