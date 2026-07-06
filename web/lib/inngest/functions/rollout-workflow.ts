import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { getService } from "@/db/queries";
import { deployments, rollouts, servers } from "@/db/schema";
import { ingestRolloutLog } from "@/lib/victoria-logs";
import { inngest } from "../client";
import { inngestEvents } from "../events";
import {
	calculateServicePlacements,
	checkForRollingUpdate,
	cleanupExistingDeployments,
	cleanupTerminalDeployments,
	createDeploymentRecords,
	issueCertificatesForService,
	prepareRollingUpdate,
	saveDeployedConfig,
	validateServers,
} from "./rollout-helpers";
import { handleRolloutFailure } from "./rollout-utils";

const PREFLIGHT_FAILURE_MESSAGES = [
	"At least one replica is required",
	"Maximum 10 replicas allowed",
	"No servers selected for deployment",
	"Stateful services can only have exactly 1 replica",
	"Stateful services must be deployed to exactly one server",
	"Migration already in progress",
];

const PREFLIGHT_FAILURE_PREFIXES = ["Server "];

const ROLLOUT_TURN_WAIT_ATTEMPTS = 360;
const ROLLOUT_TURN_WAIT_INTERVAL = "10s";

type RolloutTurnState = "acquired" | "waiting" | "terminal";

function getPreflightFailureReason(error: unknown) {
	if (!(error instanceof Error)) return null;

	if (PREFLIGHT_FAILURE_MESSAGES.includes(error.message)) {
		return error.message;
	}

	if (
		PREFLIGHT_FAILURE_PREFIXES.some((prefix) =>
			error.message.startsWith(prefix),
		)
	) {
		return error.message;
	}

	return null;
}

async function acquireRolloutTurn(
	rolloutId: string,
	serviceId: string,
): Promise<RolloutTurnState> {
	return db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);

		const rollout = await tx
			.select({ status: rollouts.status, createdAt: rollouts.createdAt })
			.from(rollouts)
			.where(eq(rollouts.id, rolloutId))
			.then((rows) => rows[0]);

		if (!rollout) {
			throw new Error("Rollout not found");
		}

		if (rollout.status !== "queued") {
			return rollout.status === "in_progress" ? "acquired" : "terminal";
		}

		const blockingRollout = await tx
			.select({ id: rollouts.id })
			.from(rollouts)
			.where(
				or(
					and(
						eq(rollouts.serviceId, serviceId),
						eq(rollouts.status, "in_progress"),
						ne(rollouts.id, rolloutId),
					),
					and(
						eq(rollouts.serviceId, serviceId),
						eq(rollouts.status, "queued"),
						lt(rollouts.createdAt, rollout.createdAt),
					),
				),
			)
			.limit(1)
			.then((rows) => rows[0]);

		if (blockingRollout) {
			return "waiting";
		}

		await tx
			.update(rollouts)
			.set({
				status: "in_progress",
				currentStage: "preparing",
			})
			.where(eq(rollouts.id, rolloutId));

		return "acquired";
	});
}

export const rolloutWorkflow = inngest.createFunction(
	{
		id: "rollout-workflow",
		triggers: [inngestEvents.rolloutCreated],
		concurrency: [{ limit: 1, key: "event.data.serviceId" }],
		cancelOn: [
			{ event: inngestEvents.rolloutCancelled, match: "data.rolloutId" },
		],
		onFailure: async ({ event }) => {
			const { rolloutId } = event.data.event.data as {
				rolloutId?: string;
			};

			if (!rolloutId) return;

			await db
				.update(rollouts)
				.set({
					status: "failed",
					currentStage: "workflow_failed",
					completedAt: new Date(),
				})
				.where(
					and(
						eq(rollouts.id, rolloutId),
						inArray(rollouts.status, ["queued", "in_progress"]),
					),
				);
		},
	},
	async ({ event, step }) => {
		const { rolloutId, serviceId } = event.data;

		await step.run("validate-service", async () => {
			const svc = await getService(serviceId);
			if (!svc) {
				throw new Error("Service not found");
			}
		});

		let acquiredTurn = false;
		for (let attempt = 0; attempt < ROLLOUT_TURN_WAIT_ATTEMPTS; attempt++) {
			const turnState = await step.run(
				`acquire-rollout-turn-${attempt}`,
				async () => {
					return acquireRolloutTurn(rolloutId, serviceId);
				},
			);

			if (turnState === "terminal") {
				return { status: "cancelled", rolloutId };
			}

			if (turnState === "acquired") {
				acquiredTurn = true;
				break;
			}

			await step.sleep(
				`wait-for-active-rollout-${attempt}`,
				ROLLOUT_TURN_WAIT_INTERVAL,
			);
		}

		if (!acquiredTurn) {
			await step.run("mark-rollout-queue-timeout", async () => {
				await db
					.update(rollouts)
					.set({
						status: "failed",
						currentStage: "queue_timeout",
						completedAt: new Date(),
					})
					.where(eq(rollouts.id, rolloutId));
				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"queue_timeout",
					"Timed out waiting for previous rollout to finish",
				);
			});
			return { status: "failed", rolloutId, reason: "queue_timeout" };
		}

		await step.run("log-rollout-started", async () => {
			await ingestRolloutLog(
				rolloutId,
				serviceId,
				"preparing",
				"Rollout started",
			);
		});

		const placementResult = await step.run("load-placements", async () => {
			const service = await getService(serviceId);
			if (!service) {
				throw new Error("Service not found");
			}
			try {
				const result = await calculateServicePlacements(service);
				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"preparing",
					`Loaded placements: ${result.totalReplicas} replica(s)`,
				);
				return { success: true as const, ...result };
			} catch (error) {
				const reason = getPreflightFailureReason(error);
				if (!reason) {
					throw error;
				}

				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"preparing",
					`Placement validation failed: ${reason}`,
				);
				await handleRolloutFailure(rolloutId, serviceId, reason, false);
				return { success: false as const, reason };
			}
		});

		if (!placementResult.success) {
			return {
				status: "failed",
				rolloutId,
				reason: placementResult.reason,
			};
		}

		const { placements, totalReplicas } = placementResult;

		const serverValidation = await step.run("validate-servers", async () => {
			try {
				const serverMap = await validateServers(placements);
				const ids = [...serverMap.keys()];
				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"preparing",
					`Validated ${ids.length} server(s)`,
				);
				return { success: true as const, serverIds: ids };
			} catch (error) {
				const reason = getPreflightFailureReason(error);
				if (!reason) {
					throw error;
				}

				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"preparing",
					`Placement failed: ${reason}`,
				);
				await handleRolloutFailure(rolloutId, serviceId, reason, false);
				return { success: false as const, reason };
			}
		});

		if (!serverValidation.success) {
			return {
				status: "failed",
				rolloutId,
				reason: serverValidation.reason,
			};
		}

		const { serverIds } = serverValidation;

		await step.run("cleanup-terminal-deployments", async () => {
			await cleanupTerminalDeployments(serviceId);
		});

		const isRollingUpdate = await step.run("check-rolling-update", async () => {
			return checkForRollingUpdate(serviceId);
		});

		if (isRollingUpdate) {
			await step.run("prepare-rolling-update", async () => {
				await prepareRollingUpdate(serviceId);
				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"preparing",
					"Prepared rolling update",
				);
			});
		} else {
			await step.run("cleanup-existing", async () => {
				const { deletedCount } = await cleanupExistingDeployments(serviceId);
				if (deletedCount > 0) {
					await ingestRolloutLog(
						rolloutId,
						serviceId,
						"preparing",
						`Cleaned up ${deletedCount} existing deployment(s)`,
					);
				}
			});
		}

		const certResult = await step.run("issue-certificates", async () => {
			await db
				.update(rollouts)
				.set({ currentStage: "certificates" })
				.where(eq(rollouts.id, rolloutId));
			try {
				const result = await issueCertificatesForService(serviceId);
				if (result.issuedDomains.length > 0) {
					await ingestRolloutLog(
						rolloutId,
						serviceId,
						"certificates",
						`Certificates issued for ${result.issuedDomains.length} domain(s)`,
					);
				}
				return { success: true as const };
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Certificate provisioning failed";
				await ingestRolloutLog(rolloutId, serviceId, "certificates", message);
				return { success: false as const, reason: message };
			}
		});

		if (!certResult.success) {
			await step.run("handle-certificate-failure", async () => {
				await handleRolloutFailure(
					rolloutId,
					serviceId,
					"certificate_provisioning_failed",
					isRollingUpdate,
				);
			});
			return {
				status: "failed",
				reason: certResult.reason,
			};
		}

		const { deploymentIds } = await step.run("create-deployments", async () => {
			await db
				.update(rollouts)
				.set({ currentStage: "deploying" })
				.where(eq(rollouts.id, rolloutId));

			const service = await getService(serviceId);
			if (!service) {
				throw new Error("Service not found");
			}

			const serverMap = await validateServers(placements);

			const result = await createDeploymentRecords(rolloutId, serviceId, {
				service,
				placements,
				serverMap,
				totalReplicas,
				isRollingUpdate,
			});

			await ingestRolloutLog(
				rolloutId,
				serviceId,
				"deploying",
				`Created ${result.deploymentIds.length} deployment(s)`,
			);

			return result;
		});

		await step.run("start-health-check", async () => {
			const service = await getService(serviceId);
			const hasHealthCheck = service?.healthCheckCmd != null;

			await db
				.update(rollouts)
				.set({ currentStage: "health_check" })
				.where(eq(rollouts.id, rolloutId));
			await ingestRolloutLog(
				rolloutId,
				serviceId,
				"health_check",
				hasHealthCheck ? "Waiting for health checks" : "Starting container",
			);
		});

		const pendingHealthDeploymentIds = await step.run(
			"get-pending-health-deployments",
			async () => {
				if (deploymentIds.length === 0) {
					return [];
				}

				const alreadyHealthy = await db
					.select({ id: deployments.id })
					.from(deployments)
					.where(
						and(
							inArray(deployments.id, deploymentIds),
							inArray(deployments.observedPhase, ["healthy", "running"]),
						),
					);

				const alreadyHealthyIds = new Set(alreadyHealthy.map((d) => d.id));
				return deploymentIds.filter((id) => !alreadyHealthyIds.has(id));
			},
		);

		const healthResults = await Promise.all(
			pendingHealthDeploymentIds.map((deploymentId) =>
				step.waitForEvent(`wait-healthy-${deploymentId}`, {
					event: inngestEvents.resourceStatusChanged,
					timeout: "10m",
					if: `async.data.type == "deployment" && async.data.id == "${deploymentId}"`,
				}),
			),
		);

		const unhealthyDeployments = await step.run(
			"check-health-after-wait",
			async () => {
				if (pendingHealthDeploymentIds.length === 0) {
					return [];
				}

				const deploymentStates = await db
					.select({
						id: deployments.id,
						observedPhase: deployments.observedPhase,
						serverName: servers.name,
					})
					.from(deployments)
					.innerJoin(servers, eq(deployments.serverId, servers.id))
					.where(inArray(deployments.id, pendingHealthDeploymentIds));

				return deploymentStates.filter(
					(deployment) =>
						deployment.observedPhase !== "healthy" &&
						deployment.observedPhase !== "running",
				);
			},
		);

		if (unhealthyDeployments.length > 0) {
			const failedDeployment = unhealthyDeployments[0];
			const failedReason = healthResults.includes(null)
				? "health_check_timeout"
				: "health_check_failed";
			await step.run("log-health-timeout", async () => {
				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"health_check",
					failedReason === "health_check_timeout"
						? `Health check timed out on server ${failedDeployment.serverName}`
						: `Health check failed on server ${failedDeployment.serverName}`,
				);
			});
			await step.run("handle-health-timeout", async () => {
				await handleRolloutFailure(
					rolloutId,
					serviceId,
					failedReason,
					isRollingUpdate,
				);
			});
			return {
				status: "failed",
				reason: failedReason,
				deploymentId: failedDeployment.id,
			};
		}

		await step.run("start-dns-sync", async () => {
			await db.transaction(async (tx) => {
				await tx
					.update(rollouts)
					.set({ currentStage: "dns_sync" })
					.where(eq(rollouts.id, rolloutId));

				await tx
					.update(deployments)
					.set({ trafficState: "active" })
					.where(
						and(
							eq(deployments.rolloutId, rolloutId),
							eq(deployments.trafficState, "candidate"),
							inArray(deployments.observedPhase, ["healthy", "running"]),
						),
					);

				await tx
					.update(deployments)
					.set({ trafficState: "draining" })
					.where(
						and(
							eq(deployments.serviceId, serviceId),
							eq(deployments.trafficState, "active"),
							or(
								ne(deployments.rolloutId, rolloutId),
								isNull(deployments.rolloutId),
							),
						),
					);
			});

			await ingestRolloutLog(
				rolloutId,
				serviceId,
				"dns_sync",
				"Routing traffic to new deployments",
			);
		});

		const dnsResults = await Promise.all(
			serverIds.map((serverId) =>
				step.waitForEvent(`wait-dns-${serverId}`, {
					event: inngestEvents.serverDnsSynced,
					timeout: "5m",
					if: `async.data.serverId == "${serverId}" && async.data.rolloutId == "${rolloutId}"`,
				}),
			),
		);

		const dnsTimedOut = dnsResults.some((r) => r === null);
		const dnsServerNames = await step.run("load-dns-server-names", async () => {
			if (serverIds.length === 0) {
				return [];
			}

			return db
				.select({ id: servers.id, name: servers.name })
				.from(servers)
				.where(inArray(servers.id, serverIds));
		});
		const dnsServerNameById = new Map(
			dnsServerNames.map((server) => [server.id, server.name]),
		);

		for (let i = 0; i < dnsResults.length; i++) {
			if (dnsResults[i] === null) {
				const serverName = dnsServerNameById.get(serverIds[i]) || serverIds[i];
				console.warn(
					`[rollout:${rolloutId}] DNS sync timeout for server ${serverName}`,
				);
				await step.run(`log-dns-timeout-${serverIds[i]}`, async () => {
					await ingestRolloutLog(
						rolloutId,
						serviceId,
						"dns_sync",
						`DNS sync timed out for server ${serverName}`,
					);
				});
			}
		}

		if (dnsTimedOut) {
			await step.run("rollback-dns-timeout", async () => {
				await handleRolloutFailure(
					rolloutId,
					serviceId,
					"dns_sync_timeout",
					isRollingUpdate,
				);
			});
			return { status: "rolled_back", rolloutId, reason: "dns_sync_timeout" };
		}

		if (isRollingUpdate) {
			await step.run("stop-old-deployments", async () => {
				const stoppedDeploymentsWithoutContainers = await db
					.update(deployments)
					.set({
						runtimeDesiredState: "removed",
						trafficState: "inactive",
					})
					.where(
						and(
							eq(deployments.serviceId, serviceId),
							eq(deployments.trafficState, "draining"),
							isNull(deployments.containerId),
						),
					)
					.returning({ id: deployments.id });

				const stoppingDeployments = await db
					.update(deployments)
					.set({
						runtimeDesiredState: "removed",
						trafficState: "inactive",
					})
					.where(
						and(
							eq(deployments.serviceId, serviceId),
							eq(deployments.trafficState, "draining"),
						),
					)
					.returning({ id: deployments.id });

				const stoppedCount =
					stoppedDeploymentsWithoutContainers.length +
					stoppingDeployments.length;
				if (stoppedCount > 0) {
					await ingestRolloutLog(
						rolloutId,
						serviceId,
						"dns_sync",
						`Stopping ${stoppedCount} old deployment(s) after DNS sync`,
					);
				}
			});
		}

		await step.run("save-deployed-config", async () => {
			const service = await getService(serviceId);
			if (!service) {
				throw new Error("Service not found");
			}

			const serverMap = await validateServers(placements);

			await saveDeployedConfig(serviceId, {
				service,
				placements,
				serverMap,
				totalReplicas,
				isRollingUpdate,
			});
		});

		await step.run("complete-rollout", async () => {
			await db
				.update(rollouts)
				.set({
					status: "completed",
					currentStage: "completed",
					completedAt: new Date(),
				})
				.where(eq(rollouts.id, rolloutId));
			await ingestRolloutLog(
				rolloutId,
				serviceId,
				"completed",
				"Rollout completed successfully",
			);
		});

		return { status: "completed", rolloutId };
	},
);
