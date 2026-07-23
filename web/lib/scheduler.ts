import { CronExpressionParser } from "cron-parser";
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
	deployments,
	rollouts,
	servers,
	serviceRevisions,
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
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import {
	AUTOMATIC_PLACEMENT_SERVER_STABILIZATION_MS,
	distributeReplicas,
	resolveRevisionPlacements,
} from "@/lib/inngest/functions/rollout-helpers";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";
import { cloneActiveRevisionAndQueueSystemRollout } from "@/lib/service-revisions";
import {
	WORK_QUEUE_LEASE_DURATION_MS,
	WORK_QUEUE_MAX_ATTEMPTS,
} from "@/lib/work-queue";

const STALE_THRESHOLD_MS = 75 * SECOND_IN_MILLISECONDS;
export const AUTOMATIC_PLACEMENT_COOLDOWN_MS = 30 * MINUTE_IN_MILLISECONDS;
export const MAX_REBALANCES_PER_RUN = 5;
export const MAX_AUTOMATIC_RECOVERIES_PER_RUN = 5;

async function enqueueSystemRollout(
	serviceId: string,
	result: { rolloutId: string; created: boolean },
): Promise<void> {
	if (!result.created) return;
	try {
		await inngest.send(
			inngestEvents.rolloutCreated.create(
				{ rolloutId: result.rolloutId, serviceId },
				{ id: `rollout-created-${result.rolloutId}` },
			),
		);
	} catch (error) {
		await db
			.update(rollouts)
			.set({
				status: "failed",
				currentStage: "enqueue_failed",
				completedAt: new Date(),
			})
			.where(
				and(eq(rollouts.id, result.rolloutId), eq(rollouts.status, "queued")),
			);
		throw error;
	}
}

export async function rebalanceAutomaticServices(
	maxCreated = MAX_REBALANCES_PER_RUN,
): Promise<number> {
	if (maxCreated <= 0) return 0;
	const now = new Date();
	const candidates = await db
		.select({
			id: services.id,
			name: services.name,
			lastAutomaticPlacementAt: services.lastAutomaticPlacementAt,
		})
		.from(services)
		.innerJoin(deployments, eq(deployments.serviceId, services.id))
		.innerJoin(
			serviceRevisions,
			eq(serviceRevisions.id, deployments.serviceRevisionId),
		)
		.where(
			and(
				isNull(services.deletedAt),
				inArray(deployments.runtimeDesiredState, ["running", "stopped"]),
				eq(deployments.trafficState, "active"),
				eq(
					sql<string>`${serviceRevisions.specification} -> 'placement' ->> 'mode'`,
					"automatic",
				),
			),
		)
		.groupBy(services.id, services.name, services.lastAutomaticPlacementAt)
		.orderBy(services.id);
	let queuedCount = 0;
	for (const service of candidates) {
		if (queuedCount >= maxCreated) break;
		if (
			service.lastAutomaticPlacementAt &&
			now.getTime() - service.lastAutomaticPlacementAt.getTime() <
				AUTOMATIC_PLACEMENT_COOLDOWN_MS
		)
			continue;
		const [pending, activeDeployments] = await Promise.all([
			db
				.select({ id: rollouts.id })
				.from(rollouts)
				.where(
					and(
						eq(rollouts.serviceId, service.id),
						inArray(rollouts.status, ["queued", "in_progress"]),
					),
				)
				.limit(1)
				.then((r) => r[0]),
			db
				.select({
					revisionId: deployments.serviceRevisionId,
					specification: serviceRevisions.specification,
				})
				.from(deployments)
				.innerJoin(
					serviceRevisions,
					eq(deployments.serviceRevisionId, serviceRevisions.id),
				)
				.where(
					and(
						eq(deployments.serviceId, service.id),
						inArray(deployments.runtimeDesiredState, ["running", "stopped"]),
						eq(deployments.trafficState, "active"),
					),
				)
				.then((rows) => rows),
		]);
		const activeRevisionIds = new Set(
			activeDeployments.map((deployment) => deployment.revisionId),
		);
		if (pending || activeRevisionIds.size !== 1) continue;
		const active = activeDeployments[0];
		if (!active) continue;
		const spec = parseServiceRevisionSpec(active.specification);
		if (spec.stateful || spec.placement.mode !== "automatic") continue;
		const eligible = await db
			.select({ id: servers.id })
			.from(servers)
			.where(
				and(
					eq(servers.status, "online"),
					isNotNull(servers.wireguardIp),
					isNotNull(servers.onlineSince),
					lt(
						servers.onlineSince,
						subtractMilliseconds(
							now,
							AUTOMATIC_PLACEMENT_SERVER_STABILIZATION_MS,
						),
					),
					...(spec.serverless.enabled ? [eq(servers.isProxy, true)] : []),
				),
			);
		if (!eligible.length) continue;
		const ideal = distributeReplicas(
			eligible.map((s) => s.id),
			spec.placement.replicas,
		);
		const desired = await db
			.select({
				serverId: deployments.serverId,
				count: sql<number>`count(*)::int`,
			})
			.from(deployments)
			.where(
				and(
					eq(deployments.serviceId, service.id),
					inArray(deployments.runtimeDesiredState, ["running", "stopped"]),
					eq(deployments.trafficState, "active"),
				),
			)
			.groupBy(deployments.serverId);
		const normalize = (
			rows: Array<{ serverId: string; count?: number; replicas?: number }>,
		) => rows.map((r) => [r.serverId, r.count ?? r.replicas]).sort();
		if (JSON.stringify(normalize(ideal)) === JSON.stringify(normalize(desired)))
			continue;
		try {
			const result = await cloneActiveRevisionAndQueueSystemRollout(
				service.id,
				active.revisionId,
			);
			if (!result.created) continue;
			queuedCount++;
			await enqueueSystemRollout(service.id, result);
		} catch (error) {
			console.error(`[scheduler] failed to rebalance ${service.name}`, error);
		}
	}
	return queuedCount;
}

export async function recoverInvalidAutomaticPlacements(
	maxCreated = MAX_AUTOMATIC_RECOVERIES_PER_RUN,
): Promise<number> {
	if (maxCreated <= 0) return 0;
	const candidateServices = await db
		.select({ serviceId: deployments.serviceId })
		.from(deployments)
		.innerJoin(services, eq(services.id, deployments.serviceId))
		.innerJoin(
			serviceRevisions,
			eq(serviceRevisions.id, deployments.serviceRevisionId),
		)
		.where(
			and(
				inArray(deployments.runtimeDesiredState, ["running", "stopped"]),
				eq(deployments.trafficState, "active"),
				isNull(services.deletedAt),
				eq(
					sql<string>`${serviceRevisions.specification} -> 'placement' ->> 'mode'`,
					"automatic",
				),
			),
		)
		.groupBy(deployments.serviceId);
	if (candidateServices.length === 0) return 0;

	const activeDeployments = await db
		.select({
			serviceId: deployments.serviceId,
			serviceName: services.name,
			revisionId: deployments.serviceRevisionId,
			specification: serviceRevisions.specification,
			serverStatus: servers.status,
			serverWireguardIp: servers.wireguardIp,
			lastRecoveryAttemptAt: services.lastAutomaticRecoveryAttemptAt,
		})
		.from(deployments)
		.innerJoin(services, eq(services.id, deployments.serviceId))
		.innerJoin(servers, eq(servers.id, deployments.serverId))
		.innerJoin(
			serviceRevisions,
			eq(serviceRevisions.id, deployments.serviceRevisionId),
		)
		.where(
			and(
				inArray(deployments.runtimeDesiredState, ["running", "stopped"]),
				eq(deployments.trafficState, "active"),
				isNull(services.deletedAt),
				inArray(
					deployments.serviceId,
					candidateServices.map((service) => service.serviceId),
				),
			),
		)
		.orderBy(deployments.serviceId, deployments.id);

	const byService = new Map<string, typeof activeDeployments>();
	for (const deployment of activeDeployments) {
		const current = byService.get(deployment.serviceId) ?? [];
		current.push(deployment);
		byService.set(deployment.serviceId, current);
	}

	const orderedServices = [...byService.entries()].sort(
		([serviceIdA, deploymentsA], [serviceIdB, deploymentsB]) => {
			const attemptedAtA = deploymentsA[0]?.lastRecoveryAttemptAt?.getTime();
			const attemptedAtB = deploymentsB[0]?.lastRecoveryAttemptAt?.getTime();
			if (attemptedAtA === undefined && attemptedAtB !== undefined) return -1;
			if (attemptedAtA !== undefined && attemptedAtB === undefined) return 1;
			if (attemptedAtA !== attemptedAtB)
				return (attemptedAtA ?? 0) - (attemptedAtB ?? 0);
			return serviceIdA.localeCompare(serviceIdB);
		},
	);
	let createdCount = 0;
	for (const [serviceId, serviceDeployments] of orderedServices) {
		if (createdCount >= maxCreated) break;
		try {
			const revisionIds = new Set(
				serviceDeployments.map((deployment) => deployment.revisionId),
			);
			if (revisionIds.size !== 1) {
				console.error(
					`[scheduler] skipping automatic recovery for ${serviceId}: multiple active revisions`,
				);
				continue;
			}
			const active = serviceDeployments[0];
			if (!active) continue;
			const specification = parseServiceRevisionSpec(active.specification);
			if (
				specification.stateful ||
				specification.placement.mode !== "automatic"
			)
				continue;
			const hasInvalidPlacement = serviceDeployments.some(
				(deployment) =>
					deployment.serverStatus !== "online" || !deployment.serverWireguardIp,
			);
			if (!hasInvalidPlacement) continue;

			const pending = await db
				.select({ id: rollouts.id })
				.from(rollouts)
				.where(
					and(
						eq(rollouts.serviceId, serviceId),
						inArray(rollouts.status, ["queued", "in_progress"]),
					),
				)
				.limit(1)
				.then((rows) => rows[0]);
			if (pending) continue;

			await db
				.update(services)
				.set({ lastAutomaticRecoveryAttemptAt: new Date() })
				.where(eq(services.id, serviceId));
			await resolveRevisionPlacements(specification);
			const result = await cloneActiveRevisionAndQueueSystemRollout(
				serviceId,
				active.revisionId,
			);
			if (!result.created) continue;
			createdCount++;
			await enqueueSystemRollout(serviceId, result);
		} catch (error) {
			console.error(
				`[scheduler] failed level-triggered recovery for ${serviceDeployments[0]?.serviceName ?? serviceId}`,
				error,
			);
		}
	}
	return createdCount;
}

async function triggerRecoveryForOfflineServers(
	offlineServerIds: string[],
	maxCreated: number,
): Promise<number> {
	if (offlineServerIds.length === 0 || maxCreated <= 0) return 0;

	const affectedDeployments = await db
		.select({
			deploymentId: deployments.id,
			serverId: deployments.serverId,
			serverName: servers.name,
			serverPublicIp: servers.publicIp,
			serverWireguardIp: servers.wireguardIp,
			serviceName: services.name,
			serviceId: services.id,
			serviceRevisionId: deployments.serviceRevisionId,
			specification: serviceRevisions.specification,
			trafficState: deployments.trafficState,
		})
		.from(deployments)
		.innerJoin(servers, eq(servers.id, deployments.serverId))
		.innerJoin(services, eq(services.id, deployments.serviceId))
		.innerJoin(
			serviceRevisions,
			eq(serviceRevisions.id, deployments.serviceRevisionId),
		)
		.where(
			and(
				inArray(deployments.serverId, offlineServerIds),
				inArray(deployments.runtimeDesiredState, ["running", "stopped"]),
				inArray(deployments.trafficState, ["candidate", "active"]),
				isNull(services.deletedAt),
			),
		)
		.orderBy(deployments.serviceId, deployments.id);

	if (affectedDeployments.length === 0) {
		console.log(
			`[scheduler] ${offlineServerIds.length} server(s) went offline; no active replicas need manual recovery`,
		);
		return 0;
	}
	const automaticActiveByService = new Map<
		string,
		(typeof affectedDeployments)[number]
	>();
	const manualDeploymentIds = new Set<string>();
	for (const deployment of affectedDeployments) {
		try {
			const specification = parseServiceRevisionSpec(deployment.specification);
			if (specification.placement.mode === "manual") {
				manualDeploymentIds.add(deployment.deploymentId);
				continue;
			}
			if (
				!specification.stateful &&
				deployment.trafficState === "active" &&
				!automaticActiveByService.has(deployment.serviceId)
			) {
				automaticActiveByService.set(deployment.serviceId, deployment);
			}
		} catch (error) {
			console.error(
				`[scheduler] cannot classify deployment ${deployment.deploymentId} for recovery`,
				error,
			);
		}
	}

	let createdCount = 0;
	for (const deployment of automaticActiveByService.values()) {
		if (createdCount >= maxCreated) break;
		try {
			const specification = parseServiceRevisionSpec(deployment.specification);
			await db
				.update(services)
				.set({ lastAutomaticRecoveryAttemptAt: new Date() })
				.where(eq(services.id, deployment.serviceId));
			await resolveRevisionPlacements(specification);
			const queued = await cloneActiveRevisionAndQueueSystemRollout(
				deployment.serviceId,
				deployment.serviceRevisionId,
			);
			if (!queued.created) continue;
			createdCount++;
			await enqueueSystemRollout(deployment.serviceId, queued);
		} catch (error) {
			console.error(
				`[scheduler] automatic recovery failed for ${deployment.serviceName}; periodic recovery will retry`,
				error,
			);
		}
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
		if (!manualDeploymentIds.has(deployment.deploymentId)) continue;
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
	return createdCount;
}

export async function checkAndRecoverStaleServers(
	excludeServerId?: string,
): Promise<number> {
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
		.set({ status: "offline", onlineSince: null })
		.where(and(...conditions))
		.returning({
			id: servers.id,
			name: servers.name,
			publicIp: servers.publicIp,
			wireguardIp: servers.wireguardIp,
		});

	if (markedOffline.length === 0) return 0;

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

	return triggerRecoveryForOfflineServers(
		offlineIds,
		MAX_AUTOMATIC_RECOVERIES_PER_RUN,
	);
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

			await deployServiceInternal(
				service.id,
				{ type: "system" },
				{
					githubTrigger: "scheduled",
				},
			);

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
