import { CronExpressionParser } from "cron-parser";
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { triggerBuild } from "@/actions/builds";
import { db } from "@/db";
import {
	deployments,
	rollouts,
	servers,
	services,
	workQueue,
} from "@/db/schema";
import {
	DAY_IN_MILLISECONDS,
	isDateAfter,
	MINUTE_IN_MILLISECONDS,
	SECOND_IN_MILLISECONDS,
	subtractMilliseconds,
} from "@/lib/date";
import { deployServiceInternal } from "@/lib/deploy-service";
import {
	sendManualRecoveryRequiredAlert,
	sendServerOfflineAlert,
} from "@/lib/email";
import {
	WORK_QUEUE_LEASE_DURATION_MS,
	WORK_QUEUE_MAX_ATTEMPTS,
} from "@/lib/work-queue";

const STALE_THRESHOLD_MS = 75 * SECOND_IN_MILLISECONDS;

async function triggerRecoveryForOfflineServers(
	offlineServerIds: string[],
): Promise<void> {
	if (offlineServerIds.length === 0) return;

	const affectedDeployments = await db
		.select({
			deploymentId: deployments.id,
			serverId: deployments.serverId,
			serverName: servers.name,
			serverPublicIp: servers.publicIp,
			serverWireguardIp: servers.wireguardIp,
			serviceName: services.name,
		})
		.from(deployments)
		.innerJoin(servers, eq(servers.id, deployments.serverId))
		.innerJoin(services, eq(services.id, deployments.serviceId))
		.where(
			and(
				inArray(deployments.serverId, offlineServerIds),
				inArray(deployments.runtimeDesiredState, ["running", "stopped"]),
				inArray(deployments.trafficState, ["candidate", "active"]),
				isNull(services.deletedAt),
			),
		);

	if (affectedDeployments.length === 0) {
		console.log(
			`[scheduler] ${offlineServerIds.length} server(s) went offline; no active replicas need manual recovery`,
		);
		return;
	}

	const affectedByServer = new Map<
		string,
		{
			serverName: string;
			serverIp?: string;
			impactedReplicas: number;
			serviceNames: Set<string>;
		}
	>();

	for (const deployment of affectedDeployments) {
		const current = affectedByServer.get(deployment.serverId) ?? {
			serverName: deployment.serverName,
			serverIp:
				deployment.serverWireguardIp || deployment.serverPublicIp || undefined,
			impactedReplicas: 0,
			serviceNames: new Set<string>(),
		};
		current.impactedReplicas += 1;
		current.serviceNames.add(deployment.serviceName);
		affectedByServer.set(deployment.serverId, current);
	}

	for (const [serverId, impact] of affectedByServer) {
		console.log(
			`[scheduler] server ${impact.serverName} went offline with ${impact.impactedReplicas} active replica(s); manual recovery required`,
		);
		sendManualRecoveryRequiredAlert({
			serverId,
			serverName: impact.serverName,
			serverIp: impact.serverIp,
			impactedReplicas: impact.impactedReplicas,
			serviceNames: [...impact.serviceNames],
		}).catch((error) => {
			console.error(
				`[scheduler] failed to send manual recovery alert for ${impact.serverName}:`,
				error,
			);
		});
	}
}

export async function checkAndRecoverStaleServers(
	excludeServerId?: string,
): Promise<void> {
	const staleThreshold = subtractMilliseconds(new Date(), STALE_THRESHOLD_MS);

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
		.where(
			and(isNotNull(services.deploymentSchedule), isNull(services.deletedAt)),
		);

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
				if (isDateAfter(nextScheduledRun, now)) {
					continue;
				}
			}

			const [inProgressRollout] = await db
				.select({ id: rollouts.id })
				.from(rollouts)
				.where(
					and(
						eq(rollouts.serviceId, service.id),
						inArray(rollouts.status, ["queued", "in_progress"]),
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
				await deployServiceInternal(service.id, { type: "system" });
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

const OLD_ITEM_THRESHOLD_MS = 90 * DAY_IN_MILLISECONDS;
const AGENT_UPGRADE_TIMEOUT_MS = 5 * MINUTE_IN_MILLISECONDS;

export async function failTimedOutAgentUpgrades(): Promise<void> {
	const timeoutThreshold = subtractMilliseconds(
		new Date(),
		AGENT_UPGRADE_TIMEOUT_MS,
	);

	const timedOut = await db
		.update(servers)
		.set({
			agentUpgradeStatus: "failed",
			agentUpgradeError: "Agent did not report the target version in time",
		})
		.where(
			and(
				eq(servers.agentUpgradeStatus, "upgrading"),
				lt(servers.agentUpgradeStartedAt, timeoutThreshold),
				sql`(${servers.agentHealth}->>'version') IS DISTINCT FROM ${servers.agentUpgradeTargetVersion}`,
			),
		)
		.returning({ id: servers.id });

	if (timedOut.length > 0) {
		await db
			.update(workQueue)
			.set({ status: "failed" })
			.where(
				and(
					inArray(
						workQueue.serverId,
						timedOut.map((server) => server.id),
					),
					eq(workQueue.type, "upgrade_agent"),
					inArray(workQueue.status, ["pending", "processing"]),
				),
			);
		console.log(
			`[scheduler] marked ${timedOut.length} agent upgrade(s) timed out`,
		);
	}
}

export async function cleanupStaleItems(): Promise<void> {
	const workItemLeaseThreshold = subtractMilliseconds(
		new Date(),
		WORK_QUEUE_LEASE_DURATION_MS,
	);
	const oldThreshold = subtractMilliseconds(new Date(), OLD_ITEM_THRESHOLD_MS);

	// Pending work is intentionally retained so commands can run when an agent
	// reconnects. Only exhausted processing attempts are failed here.
	const staleWorkItems = await db
		.update(workQueue)
		.set({ status: "failed" })
		.where(
			and(
				eq(workQueue.status, "processing"),
				lt(workQueue.startedAt, workItemLeaseThreshold),
				sql`${workQueue.attempts} >= ${WORK_QUEUE_MAX_ATTEMPTS}`,
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
