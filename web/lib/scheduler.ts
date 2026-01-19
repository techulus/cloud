import { db } from "@/db";
import {
	deployments,
	rollouts,
	servers,
	services,
	serviceReplicas,
	workQueue,
} from "@/db/schema";
import { and, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { calculateSpreadPlacement } from "@/lib/placement";
import { deployService } from "@/actions/projects";
import { triggerBuild } from "@/actions/builds";
import {
	sendServerOfflineAlert,
	sendDeploymentMovedAlert,
} from "@/lib/email";

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

			sendDeploymentMovedAlert({
				serviceId,
				reason: "Server went offline",
			}).catch((error) => {
				console.error(
					`[scheduler] failed to send deployment moved alert for ${serviceId}:`,
					error,
				);
			});

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
		.returning({
			id: servers.id,
			name: servers.name,
			publicIp: servers.publicIp,
			wireguardIp: servers.wireguardIp,
		});

	if (markedOffline.length === 0) return;

	const offlineIds = markedOffline.map((s) => s.id);
	console.log(
		`[scheduler] marked ${offlineIds.length} stale servers offline, triggering recovery`,
	);

	for (const server of markedOffline) {
		sendServerOfflineAlert({
			serverName: server.name,
			serverIp: server.wireguardIp || server.publicIp || undefined,
		}).catch((error) => {
			console.error(
				`[scheduler] failed to send offline alert for ${server.name}:`,
				error,
			);
		});
	}

	triggerRecoveryForOfflineServers(offlineIds).catch((error) => {
		console.error("[scheduler] recovery failed:", error);
	});
}

export async function checkAndRunScheduledDeployments(): Promise<void> {
	console.log("[scheduler] checking scheduled deployments");

	const scheduledServices = await db
		.select({
			id: services.id,
			name: services.name,
			sourceType: services.sourceType,
			schedule: services.deploymentSchedule,
			lastScheduledDeploymentRunAt: services.lastScheduledDeploymentRunAt,
		})
		.from(services)
		.where(isNotNull(services.deploymentSchedule));

	if (scheduledServices.length === 0) return;

	for (const service of scheduledServices) {
		if (!service.schedule) continue;

		try {
			const now = new Date();

			if (service.lastScheduledDeploymentRunAt) {
				const interval = CronExpressionParser.parse(service.schedule, {
					currentDate: service.lastScheduledDeploymentRunAt,
				});
				const nextScheduledRun = interval.next().toDate();
				if (nextScheduledRun > now) {
					continue;
				}
			}

			const [inProgressRollout] = await db
				.select({ id: rollouts.id })
				.from(rollouts)
				.where(
					and(
						eq(rollouts.serviceId, service.id),
						eq(rollouts.status, "in_progress"),
					),
				)
				.limit(1);

			if (inProgressRollout) {
				console.log(
					`[scheduler] skipping ${service.name} - deployment already in progress`,
				);
				continue;
			}

			await db
				.update(services)
				.set({ lastScheduledDeploymentRunAt: new Date() })
				.where(eq(services.id, service.id));

			console.log(
				`[scheduler] triggering scheduled deployment for ${service.name} (sourceType=${service.sourceType})`,
			);

			if (service.sourceType === "github") {
				await triggerBuild(service.id, "scheduled");
			} else {
				await deployService(service.id);
			}

			console.log(
				`[scheduler] ${service.name}: deployment triggered successfully`,
			);
		} catch (error) {
			console.error(
				`[scheduler] failed to process schedule for ${service.name}:`,
				error,
			);
		}
	}

	console.log("[scheduler] finished checking scheduled deployments");
}

const STALE_ITEM_THRESHOLD_MS = 15 * 60 * 1000;
const OLD_ITEM_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

export async function cleanupStaleItems(): Promise<void> {
	const staleThreshold = new Date(Date.now() - STALE_ITEM_THRESHOLD_MS);
	const oldThreshold = new Date(Date.now() - OLD_ITEM_THRESHOLD_MS);

	const staleRollouts = await db
		.update(rollouts)
		.set({
			status: "failed",
			currentStage: "timeout",
			completedAt: new Date(),
		})
		.where(
			and(
				eq(rollouts.status, "in_progress"),
				lt(rollouts.createdAt, staleThreshold),
			),
		)
		.returning({ id: rollouts.id });

	if (staleRollouts.length > 0) {
		console.log(
			`[scheduler] cleaned up ${staleRollouts.length} stale rollouts`,
		);
	}

	const staleWorkItems = await db
		.update(workQueue)
		.set({ status: "failed" })
		.where(
			and(
				inArray(workQueue.status, ["pending", "processing"]),
				lt(workQueue.createdAt, staleThreshold),
			),
		)
		.returning({ id: workQueue.id });

	if (staleWorkItems.length > 0) {
		console.log(
			`[scheduler] cleaned up ${staleWorkItems.length} stale work queue items`,
		);
	}

	const deletedRollouts = await db
		.delete(rollouts)
		.where(lt(rollouts.createdAt, oldThreshold))
		.returning({ id: rollouts.id });

	if (deletedRollouts.length > 0) {
		console.log(`[scheduler] deleted ${deletedRollouts.length} old rollouts`);
	}

	const deletedWorkItems = await db
		.delete(workQueue)
		.where(lt(workQueue.createdAt, oldThreshold))
		.returning({ id: workQueue.id });

	if (deletedWorkItems.length > 0) {
		console.log(
			`[scheduler] deleted ${deletedWorkItems.length} old work queue items`,
		);
	}
}
