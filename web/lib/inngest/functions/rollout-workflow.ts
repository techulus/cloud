import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { db } from "@/db";
import { getService } from "@/db/queries";
import {
	deployments,
	rollouts,
	servers,
	serviceRevisions,
	services,
} from "@/db/schema";
import { isObservedReady, observedReadyPhases } from "@/lib/deployment-status";
import { buildRoutingTargets } from "@/lib/routing-sync";
import {
	canDeployServiceRevision,
	updatePreviewGitHubStatus,
} from "@/lib/preview-deployments";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";
import { getRolloutServiceRevision } from "@/lib/service-revisions";
import { reportOperationFailure } from "@/lib/server-errors";
import { ingestRolloutLog } from "@/lib/victoria-logs";
import { enqueueReconcileForAllOnlineServers } from "@/lib/work-queue";
import { inngest } from "../client";
import { inngestEvents } from "../events";
import {
	checkForRollingUpdate,
	cleanupExistingDeployments,
	cleanupTerminalDeployments,
	completeRollout,
	createDeploymentRecords,
	issueCertificatesForRevision,
	resolveRevisionPlacements,
	validateServers,
} from "./rollout-helpers";
import { handleRolloutFailure } from "./rollout-utils";

const PREFLIGHT_FAILURE_MESSAGES = [
	"At least one replica is required",
	"Maximum 32 replicas allowed",
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

export async function acquireRolloutTurn(
	rolloutId: string,
	serviceId: string,
): Promise<RolloutTurnState> {
	return db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);

		const rollout = await tx
			.select({
				status: rollouts.status,
				currentStage: rollouts.currentStage,
				createdAt: rollouts.createdAt,
			})
			.from(rollouts)
			.where(eq(rollouts.id, rolloutId))
			.then((rows) => rows[0]);

		if (!rollout) {
			throw new Error("Rollout not found");
		}

		const recoverableEnqueueFailure =
			rollout.status === "failed" && rollout.currentStage === "enqueue_failed";
		if (rollout.status !== "queued" && !recoverableEnqueueFailure) {
			return rollout.status === "in_progress" ? "acquired" : "terminal";
		}

		if (recoverableEnqueueFailure) {
			const newerIntent = await tx
				.select({ id: rollouts.id })
				.from(rollouts)
				.where(
					and(
						eq(rollouts.serviceId, serviceId),
						ne(rollouts.id, rolloutId),
						gte(rollouts.createdAt, rollout.createdAt),
					),
				)
				.limit(1)
				.then((rows) => rows[0]);

			if (newerIntent) {
				await tx
					.update(rollouts)
					.set({ currentStage: "superseded" })
					.where(
						and(
							eq(rollouts.id, rolloutId),
							eq(rollouts.status, "failed"),
							eq(rollouts.currentStage, "enqueue_failed"),
						),
					);
				return "terminal";
			}
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

		const acquired = await tx
			.update(rollouts)
			.set({
				status: "in_progress",
				currentStage: "preparing",
				completedAt: null,
			})
			.where(
				and(
					eq(rollouts.id, rolloutId),
					recoverableEnqueueFailure
						? and(
								eq(rollouts.status, "failed"),
								eq(rollouts.currentStage, "enqueue_failed"),
							)
						: eq(rollouts.status, "queued"),
				),
			)
			.returning({ id: rollouts.id });

		return acquired.length > 0 ? "acquired" : "terminal";
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
			const { rolloutId, serviceId } = event.data.event.data as {
				rolloutId?: string;
				serviceId?: string;
			};

			if (!rolloutId) return;
			if (serviceId) {
				await handleRolloutFailure({
					rolloutId,
					serviceId,
					reason: "workflow_failed",
					failureStage: "workflow_failed",
					isRollingUpdate: true,
				});
			}

			const fallbackFailure = await db
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
				)
				.returning({
					serviceId: rollouts.serviceId,
					serviceRevisionId: rollouts.serviceRevisionId,
				})
				.then((rows) => rows[0]);
			if (fallbackFailure) {
				reportOperationFailure("rollout.failed", {
					occurrenceId: rolloutId,
					reason: "workflow_failed",
					tags: {
						rolloutId,
						serviceId: fallbackFailure.serviceId,
						...(fallbackFailure.serviceRevisionId
							? { revisionId: fallbackFailure.serviceRevisionId }
							: {}),
						failureStage: "workflow_failed",
						rollbackState: "failed",
					},
				});
			}
		},
	},
	async ({ event, step }) => {
		const { rolloutId, serviceId } = event.data;

		const isPreview = await step.run("validate-service", async () => {
			const svc = await getService(serviceId);
			if (!svc) {
				throw new Error("Service not found");
			}
			return Boolean(svc.previewOfService);
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
				const failed = await db
					.update(rollouts)
					.set({
						status: "failed",
						currentStage: "queue_timeout",
						completedAt: new Date(),
					})
					.where(and(eq(rollouts.id, rolloutId), eq(rollouts.status, "queued")))
					.returning({ serviceRevisionId: rollouts.serviceRevisionId })
					.then((rows) => rows[0]);
				if (failed) {
					reportOperationFailure("rollout.failed", {
						occurrenceId: rolloutId,
						reason: "queue_timeout",
						tags: {
							rolloutId,
							serviceId,
							...(failed.serviceRevisionId
								? { revisionId: failed.serviceRevisionId }
								: {}),
							failureStage: "queue_timeout",
							rollbackState: "failed",
						},
					});
				}
				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"queue_timeout",
					"Timed out waiting for previous rollout to finish",
				);
			});
			return { status: "failed", rolloutId, reason: "queue_timeout" };
		}

		const revision = await step.run("load-service-revision", async () => {
			const rolloutRevision = await getRolloutServiceRevision(rolloutId);
			const executionSpecification: ServiceRevisionSpec = {
				...rolloutRevision.specification,
				secrets: [],
			};
			return {
				id: rolloutRevision.id,
				specification: executionSpecification,
			};
		});
		const specification = revision.specification;
		const currentRevision =
			!isPreview ||
			(await step.run("validate-current-preview-revision", () =>
				canDeployServiceRevision(serviceId, revision.id),
			));
		if (!currentRevision) {
			await step.run("mark-superseded-preview-rollout", () =>
				db
					.update(rollouts)
					.set({
						status: "failed",
						currentStage: "superseded",
						completedAt: new Date(),
					})
					.where(eq(rollouts.id, rolloutId)),
			);
			return { status: "cancelled", rolloutId };
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
			try {
				const result = await resolveRevisionPlacements(specification);
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
				await handleRolloutFailure({
					rolloutId,
					serviceId,
					reason,
					failureStage: "preflight_failed",
					isRollingUpdate: false,
					report: false,
				});
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
				const serverMap = await validateServers(
					placements,
					specification.serverless.enabled,
				);
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
				await handleRolloutFailure({
					rolloutId,
					serviceId,
					reason,
					failureStage: "preflight_failed",
					isRollingUpdate: false,
					report: false,
				});
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
			return checkForRollingUpdate(serviceId, specification);
		});

		if (!isRollingUpdate) {
			await step.run("cleanup-existing", async () => {
				const { deletedCount } = await cleanupExistingDeployments(
					rolloutId,
					serviceId,
				);
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

		let certificatesIssued = false;
		let certificateFailureReason = "Certificate provisioning failed";
		for (let attempt = 1; attempt <= 3; attempt++) {
			const certResult = await step.run(
				`issue-certificates-${attempt}`,
				async () => {
					await db
						.update(rollouts)
						.set({ currentStage: "certificates" })
						.where(eq(rollouts.id, rolloutId));
					try {
						const result = await issueCertificatesForRevision(specification);
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
						await ingestRolloutLog(
							rolloutId,
							serviceId,
							"certificates",
							message,
						);
						return { success: false as const, reason: message };
					}
				},
			);
			if (certResult.success) {
				certificatesIssued = true;
				break;
			}

			certificateFailureReason = certResult.reason;
			if (attempt < 3) {
				await step.sleep(
					`wait-for-certificate-retry-${attempt}`,
					attempt === 1 ? "10s" : "20s",
				);
			}
		}

		if (!certificatesIssued) {
			await step.run("handle-certificate-failure", async () => {
				await handleRolloutFailure({
					rolloutId,
					serviceId,
					reason: "certificate_provisioning_failed",
					failureStage: "certificate_provisioning_failed",
					isRollingUpdate,
				});
			});
			return {
				status: "failed",
				reason: certificateFailureReason,
			};
		}

		const { deploymentIds } = await step.run("create-deployments", async () => {
			if (
				isPreview &&
				!(await canDeployServiceRevision(serviceId, revision.id))
			) {
				throw new Error("Preview revision was superseded before deployment");
			}
			await db
				.update(rollouts)
				.set({ currentStage: "deploying" })
				.where(eq(rollouts.id, rolloutId));

			const serverMap = await validateServers(
				placements,
				specification.serverless.enabled,
			);

			const result = await createDeploymentRecords(rolloutId, serviceId, {
				revisionId: revision.id,
				isPreview,
				specification,
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
			const hasHealthCheck = specification.healthCheck != null;

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
							inArray(deployments.observedPhase, observedReadyPhases),
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
					(deployment) => !isObservedReady(deployment.observedPhase),
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
				await handleRolloutFailure({
					rolloutId,
					serviceId,
					reason: failedReason,
					failureStage: failedReason,
					isRollingUpdate,
				});
			});
			return {
				status: "failed",
				reason: failedReason,
				deploymentId: failedDeployment.id,
			};
		}

		const routingTargetResult = await step.run(
			"prepare-routing-sync",
			async () => {
				const isPublic = specification.ports.some((port) => port.isPublic);
				const proxyServerIds = isPublic
					? await db
							.select({ id: servers.id })
							.from(servers)
							.where(
								and(eq(servers.isProxy, true), eq(servers.status, "online")),
							)
							.then((rows) => rows.map((server) => server.id))
					: [];
				const targetIds = buildRoutingTargets({
					workloadServerIds: serverIds,
					proxyServerIds,
					isPublic,
				});
				await db
					.update(rollouts)
					.set({ routingTargets: targetIds })
					.where(eq(rollouts.id, rolloutId));

				return { targetIds };
			},
		);
		const routingTargetIds = routingTargetResult.targetIds;

		const dnsWaits = routingTargetIds.map((serverId) =>
			step.waitForEvent(`wait-dns-${serverId}`, {
				event: inngestEvents.serverDnsSynced,
				timeout: "5m",
				if: `async.data.serverId == "${serverId}" && async.data.rolloutId == "${rolloutId}"`,
			}),
		);
		const dnsResultsWithTrigger = await Promise.all([
			...dnsWaits,
			step.run("start-dns-sync", async () => {
				await db.transaction(async (tx) => {
					await tx.execute(
						sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`,
					);
					if (isPreview) {
						const latestRevision = await tx
							.select({ id: serviceRevisions.id })
							.from(serviceRevisions)
							.innerJoin(services, eq(services.id, serviceRevisions.serviceId))
							.where(
								and(
									eq(serviceRevisions.serviceId, serviceId),
									isNull(services.deletedAt),
								),
							)
							.orderBy(
								desc(serviceRevisions.createdAt),
								desc(serviceRevisions.id),
							)
							.limit(1)
							.then((rows) => rows[0]);
						if (latestRevision?.id !== revision.id) {
							throw new Error("Preview revision was superseded before routing");
						}
					}
					const [rollout] = await tx
						.select({ status: rollouts.status })
						.from(rollouts)
						.where(eq(rollouts.id, rolloutId))
						.for("update");
					if (rollout?.status !== "in_progress") {
						throw new Error("Rollout is no longer in progress");
					}

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
								inArray(deployments.observedPhase, observedReadyPhases),
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

					await enqueueReconcileForAllOnlineServers(
						"rollout_routing_changed",
						tx,
					);
				});

				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"dns_sync",
					"Routing traffic to new deployments",
				);
			}),
		]);
		const dnsResults = dnsResultsWithTrigger.slice(0, routingTargetIds.length);

		const dnsTimedOut = dnsResults.some((r) => r === null);
		const dnsServerNames = await step.run("load-dns-server-names", async () => {
			if (routingTargetIds.length === 0) {
				return [];
			}

			return db
				.select({ id: servers.id, name: servers.name })
				.from(servers)
				.where(inArray(servers.id, routingTargetIds));
		});
		const dnsServerNameById = new Map(
			dnsServerNames.map((server) => [server.id, server.name]),
		);

		for (let i = 0; i < dnsResults.length; i++) {
			if (dnsResults[i] === null) {
				const serverName =
					dnsServerNameById.get(routingTargetIds[i]) || routingTargetIds[i];
				console.warn(
					`[rollout:${rolloutId}] routing sync timeout for server ${serverName}`,
				);
				await step.run(`log-dns-timeout-${routingTargetIds[i]}`, async () => {
					await ingestRolloutLog(
						rolloutId,
						serviceId,
						"dns_sync",
						`Routing sync timed out for server ${serverName}`,
					);
				});
			}
		}

		if (dnsTimedOut) {
			await step.run("rollback-dns-timeout", async () => {
				await handleRolloutFailure({
					rolloutId,
					serviceId,
					reason: "dns_sync_timeout",
					failureStage: "dns_sync_timeout",
					isRollingUpdate,
				});
			});
			return { status: "rolled_back", rolloutId, reason: "dns_sync_timeout" };
		}

		const rolloutCompleted = await step.run("complete-rollout", async () => {
			if (
				isPreview &&
				!(await canDeployServiceRevision(serviceId, revision.id))
			) {
				return false;
			}
			const result = await completeRollout(rolloutId, serviceId, {
				revisionId: revision.id,
				isPreview,
				specification,
				placements,
				totalReplicas,
				isRollingUpdate,
			});
			if (!result.completed) return false;
			if (result.stoppedCount > 0) {
				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"dns_sync",
					`Stopping ${result.stoppedCount} old deployment(s) after routing sync`,
				);
			}
			await ingestRolloutLog(
				rolloutId,
				serviceId,
				"completed",
				"Rollout completed successfully",
			);
			return true;
		});
		if (!rolloutCompleted) {
			return { status: "cancelled", rolloutId };
		}
		if (isPreview) {
			await step.run("report-preview-ready", () =>
				updatePreviewGitHubStatus({
					serviceId,
					serviceRevisionId: revision.id,
					state: "success",
					description: "Preview is ready",
				}),
			);
		}

		return { status: "completed", rolloutId };
	},
);
