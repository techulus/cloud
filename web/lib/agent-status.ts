import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
	type AgentHealth,
	type ContainerHealth,
	deploymentPorts,
	deployments,
	type NetworkHealth,
	rollouts,
	servers,
	services,
	workQueue,
} from "@/db/schema";
import {
	AUTOHEAL_MAX_RECREATES,
	AUTOHEAL_MAX_RESTARTS,
	AUTOHEAL_UNHEALTHY_REPORTS,
	getStartingHealthCheckFailureUpdate,
	getSteadyStateRecreateDecision,
} from "@/lib/autoheal-policy";
import { markDeploymentUndesired } from "@/lib/deployment-status";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { getServerlessWakeFailureUpdate } from "@/lib/serverless-wake-failures";
import {
	getDeployedServerlessConfig,
	getDeployedStateful,
} from "@/lib/service-config";
import { ingestRolloutLog } from "@/lib/victoria-logs";
import { enqueueWork } from "@/lib/work-queue";

type ContainerStatus = {
	deploymentId: string;
	containerId: string;
	status: "running" | "stopped" | "failed";
	healthStatus: "none" | "starting" | "healthy" | "unhealthy";
};

type DeploymentError = {
	deploymentId: string;
	message: string;
};

export type ServerlessTransition =
	| { type: "sleep"; deploymentId: string; containerId: string }
	| { type: "wake_started"; deploymentId: string }
	| { type: "wake_failed"; deploymentId: string; error: string };

export function shouldAttachReportedContainer(status: string) {
	return status === "pending" || status === "pulling" || status === "waking";
}

function isMigrationTargetStarting(status: string | null | undefined) {
	return status === "deploying_target" || status === "starting";
}

async function getServerLogName(serverId: string) {
	const server = await db
		.select({ name: servers.name })
		.from(servers)
		.where(eq(servers.id, serverId))
		.then((r) => r[0]);

	return server?.name || serverId;
}

async function completeTargetMigration(serviceId: string) {
	await db
		.update(services)
		.set({
			migrationStatus: null,
			migrationTargetServerId: null,
			migrationBackupId: null,
			migrationError: null,
		})
		.where(
			and(
				eq(services.id, serviceId),
				inArray(services.migrationStatus, ["deploying_target", "starting"]),
			),
		);
}

async function applyDeploymentErrors(
	serverId: string,
	errors: DeploymentError[],
) {
	for (const error of errors) {
		if (!error.deploymentId || !error.message?.trim()) continue;

		const deployment = await db
			.select({
				id: deployments.id,
				serviceId: deployments.serviceId,
				rolloutId: deployments.rolloutId,
				status: deployments.status,
				serverlessWakeFailureCount: deployments.serverlessWakeFailureCount,
				serverlessEnabled: services.serverlessEnabled,
				serverlessSleepAfterSeconds: services.serverlessSleepAfterSeconds,
				serverlessWakeTimeoutSeconds: services.serverlessWakeTimeoutSeconds,
				serverlessMinReadyReplicas: services.serverlessMinReadyReplicas,
				stateful: services.stateful,
				deployedConfig: services.deployedConfig,
				rolloutStatus: rollouts.status,
				serverName: servers.name,
			})
			.from(deployments)
			.innerJoin(servers, eq(deployments.serverId, servers.id))
			.innerJoin(services, eq(deployments.serviceId, services.id))
			.leftJoin(rollouts, eq(deployments.rolloutId, rollouts.id))
			.where(
				and(
					eq(deployments.id, error.deploymentId),
					eq(deployments.serverId, serverId),
				),
			)
			.then((rows) => rows[0]);

		if (!deployment) {
			continue;
		}

		const isServerlessWakeDeployment = deployment.status === "waking";
		const isActiveRolloutDeployment =
			!isServerlessWakeDeployment &&
			deployment.rolloutId &&
			deployment.rolloutStatus === "in_progress";

		if (!isActiveRolloutDeployment && !isServerlessWakeDeployment) {
			continue;
		}

		const updated = await db
			.update(deployments)
			.set(
				isServerlessWakeDeployment
					? getServerlessWakeFailureUpdate({
							serverlessEnabled:
								getDeployedServerlessConfig(deployment).enabled,
							currentFailureCount: deployment.serverlessWakeFailureCount,
							failedStage: "serverless_wake",
						})
					: { status: "failed", failedStage: "deploying" },
			)
			.where(
				and(
					eq(deployments.id, deployment.id),
					inArray(
						deployments.status,
						isServerlessWakeDeployment
							? ["waking"]
							: ["pending", "pulling", "starting"],
					),
				),
			)
			.returning({ id: deployments.id });

		if (updated.length === 0) continue;

		if (isServerlessWakeDeployment) {
			console.log(
				`[serverless:wake] deployment ${deployment.id} failed on server ${deployment.serverName}: ${formatDeploymentError(error.message)}`,
			);
			await inngest.send(
				inngestEvents.resourceStatusChanged.create({
					type: "deployment",
					id: deployment.id,
					parentType: "service",
					parentId: deployment.serviceId,
				}),
			);
			continue;
		}

		if (!deployment.rolloutId) continue;

		await ingestRolloutLog(
			deployment.rolloutId,
			deployment.serviceId,
			"deploying",
			`Deployment failed on server ${deployment.serverName}: ${formatDeploymentError(error.message)}`,
		);

		await inngest.send(
			inngestEvents.resourceStatusChanged.create({
				type: "deployment",
				id: deployment.id,
				parentType: "rollout",
				parentId: deployment.rolloutId,
			}),
		);
	}
}

async function applyServerlessTransitions(
	serverId: string,
	transitions: ServerlessTransition[],
) {
	for (const transition of transitions) {
		if (!isValidServerlessTransition(transition)) {
			console.log(`[serverless:status] rejected malformed transition`);
			continue;
		}

		const deployment = await db
			.select({
				id: deployments.id,
				serviceId: deployments.serviceId,
				serverId: deployments.serverId,
				containerId: deployments.containerId,
				status: deployments.status,
				desired: deployments.desired,
				serverlessWakeFailureCount: deployments.serverlessWakeFailureCount,
				serverlessEnabled: services.serverlessEnabled,
				serverlessSleepAfterSeconds: services.serverlessSleepAfterSeconds,
				serverlessWakeTimeoutSeconds: services.serverlessWakeTimeoutSeconds,
				serverlessMinReadyReplicas: services.serverlessMinReadyReplicas,
				stateful: services.stateful,
				deployedConfig: services.deployedConfig,
				serverIsProxy: servers.isProxy,
				serverName: servers.name,
			})
			.from(deployments)
			.innerJoin(services, eq(deployments.serviceId, services.id))
			.innerJoin(servers, eq(deployments.serverId, servers.id))
			.where(eq(deployments.id, transition.deploymentId))
			.then((rows) => rows[0]);

		const invalidReason = getInvalidServerlessTransitionReason({
			serverId,
			transition,
			deployment,
		});
		if (invalidReason || !deployment) {
			console.log(
				`[serverless:status] rejected ${transition.type} for deployment ${transition.deploymentId}: ${invalidReason}`,
			);
			continue;
		}

		if (transition.type === "sleep") {
			const updated = await db
				.update(deployments)
				.set({
					status: "sleeping",
					containerId: null,
					healthStatus: null,
					failedStage: null,
				})
				.where(
					and(
						eq(deployments.id, transition.deploymentId),
						eq(deployments.serverId, serverId),
						eq(deployments.containerId, transition.containerId),
						eq(deployments.desired, true),
						inArray(deployments.status, ["healthy", "running"]),
					),
				)
				.returning({ id: deployments.id });

			if (updated.length > 0) {
				console.log(
					`[serverless:status] deployment ${transition.deploymentId} slept on proxy ${deployment.serverName}`,
				);
				await emitDeploymentStatusChanged(
					transition.deploymentId,
					deployment.serviceId,
				);
			}
			continue;
		}

		if (transition.type === "wake_started") {
			const updated = await db
				.update(deployments)
				.set({
					status: "waking",
					containerId: null,
					healthStatus: null,
					failedStage: null,
				})
				.where(
					and(
						eq(deployments.id, transition.deploymentId),
						eq(deployments.serverId, serverId),
						eq(deployments.desired, true),
						eq(deployments.status, "sleeping"),
					),
				)
				.returning({ id: deployments.id });

			if (updated.length > 0) {
				console.log(
					`[serverless:status] deployment ${transition.deploymentId} wake started on proxy ${deployment.serverName}`,
				);
				await emitDeploymentStatusChanged(
					transition.deploymentId,
					deployment.serviceId,
				);
			}
			continue;
		}

		const updated = await db
			.update(deployments)
			.set(
				getServerlessWakeFailureUpdate({
					serverlessEnabled: getDeployedServerlessConfig(deployment).enabled,
					currentFailureCount: deployment.serverlessWakeFailureCount,
					failedStage: "serverless_wake",
				}),
			)
			.where(
				and(
					eq(deployments.id, transition.deploymentId),
					eq(deployments.serverId, serverId),
					eq(deployments.desired, true),
					inArray(deployments.status, ["sleeping", "waking"]),
				),
			)
			.returning({ id: deployments.id });

		if (updated.length > 0) {
			console.log(
				`[serverless:status] deployment ${transition.deploymentId} wake failed on proxy ${deployment.serverName}: ${formatDeploymentError(transition.error)}`,
			);
			await emitDeploymentStatusChanged(
				transition.deploymentId,
				deployment.serviceId,
			);
		}
	}
}

function isValidServerlessTransition(
	transition: unknown,
): transition is ServerlessTransition {
	if (!transition || typeof transition !== "object") return false;
	const candidate = transition as ServerlessTransition;
	if (typeof candidate.deploymentId !== "string" || !candidate.deploymentId) {
		return false;
	}
	if (candidate.type === "sleep") {
		return typeof candidate.containerId === "string" && !!candidate.containerId;
	}
	if (candidate.type === "wake_started") {
		return true;
	}
	if (candidate.type === "wake_failed") {
		return typeof candidate.error === "string" && !!candidate.error.trim();
	}
	return false;
}

function getInvalidServerlessTransitionReason({
	serverId,
	transition,
	deployment,
}: {
	serverId: string;
	transition: ServerlessTransition;
	deployment:
		| {
				serverId: string;
				containerId: string | null;
				status: string;
				desired: boolean;
				serverlessEnabled: boolean;
				serverlessSleepAfterSeconds: number;
				serverlessWakeTimeoutSeconds: number;
				serverlessMinReadyReplicas: number;
				stateful: boolean;
				deployedConfig: string | null;
				serverIsProxy: boolean;
		  }
		| undefined;
}) {
	if (!deployment) return "deployment not found";
	if (deployment.serverId !== serverId) return "deployment belongs to another server";
	if (!deployment.serverIsProxy) return "server is not a proxy";
	if (!getDeployedServerlessConfig(deployment).enabled) {
		return "service is not serverless";
	}
	if (getDeployedStateful(deployment)) return "service is stateful";
	if (!deployment.desired) return "deployment is not desired";

	if (transition.type === "sleep") {
		if (!["healthy", "running"].includes(deployment.status)) {
			return `deployment is not sleepable from ${deployment.status}`;
		}
		if (deployment.containerId !== transition.containerId) {
			return "stale containerId";
		}
	}

	if (
		transition.type === "wake_started" &&
		deployment.status !== "sleeping"
	) {
		return `deployment is not sleeping (${deployment.status})`;
	}

	if (
		transition.type === "wake_failed" &&
		!["sleeping", "waking"].includes(deployment.status)
	) {
		return `deployment is not waking or sleeping (${deployment.status})`;
	}

	return null;
}

async function emitDeploymentStatusChanged(deploymentId: string, serviceId: string) {
	await inngest.send(
		inngestEvents.resourceStatusChanged.create({
			type: "deployment",
			id: deploymentId,
			parentType: "service",
			parentId: serviceId,
		}),
	);
}

function formatDeploymentError(message: string): string {
	return message.trim().replace(/\s+/g, " ").slice(0, 1000);
}

export type StatusReport = {
	resources?: {
		cpuCores: number;
		memoryMb: number;
		diskGb: number;
	};
	publicIp?: string;
	privateIp?: string;
	meta?: Record<string, string>;
	containers: ContainerStatus[];
	dnsInSync?: boolean;
	networkHealth?: NetworkHealth;
	containerHealth?: ContainerHealth;
	agentHealth?: AgentHealth;
	deploymentErrors?: DeploymentError[];
};

export async function applyStatusReport(
	serverId: string,
	report: StatusReport,
	serverlessTransitions: ServerlessTransition[] = [],
) {
	const updateData: Record<string, unknown> = {
		lastHeartbeat: new Date(),
		status: "online",
	};
	let completedAgentUpgradeTarget: string | null = null;

	if (report.resources) {
		if (report.resources.cpuCores !== undefined) {
			updateData.resourcesCpu = report.resources.cpuCores;
		}
		if (report.resources.memoryMb !== undefined) {
			updateData.resourcesMemory = report.resources.memoryMb;
		}
		if (report.resources.diskGb !== undefined) {
			updateData.resourcesDisk = report.resources.diskGb;
		}
	}

	if (report.publicIp) {
		updateData.publicIp = report.publicIp;
	}

	updateData.privateIp = report.privateIp || null;

	if (report.meta) {
		updateData.meta = report.meta;
	}

	if (report.networkHealth) {
		updateData.networkHealth = report.networkHealth;
	}
	if (report.containerHealth) {
		updateData.containerHealth = report.containerHealth;
	}
	if (report.agentHealth) {
		updateData.agentHealth = report.agentHealth;

		const [server] = await db
			.select({
				agentUpgradeTargetVersion: servers.agentUpgradeTargetVersion,
				agentUpgradeStatus: servers.agentUpgradeStatus,
			})
			.from(servers)
			.where(eq(servers.id, serverId))
			.limit(1);

		if (
			server?.agentUpgradeTargetVersion === report.agentHealth.version &&
			server.agentUpgradeStatus !== "succeeded" &&
			server.agentUpgradeStatus !== "idle"
		) {
			updateData.agentUpgradeStatus = "succeeded";
			updateData.agentUpgradeError = null;
			completedAgentUpgradeTarget = report.agentHealth.version;
		}
	}

	await db.update(servers).set(updateData).where(eq(servers.id, serverId));
	if (completedAgentUpgradeTarget) {
		await db
			.update(workQueue)
			.set({ status: "completed" })
			.where(
				and(
					eq(workQueue.serverId, serverId),
					eq(workQueue.type, "upgrade_agent"),
					inArray(workQueue.status, ["pending", "processing"]),
				),
			);
	}

	let serverLogName: string | undefined;
	const getCurrentServerLogName = async () => {
		serverLogName ??= await getServerLogName(serverId);
		return serverLogName;
	};

	await applyDeploymentErrors(serverId, report.deploymentErrors || []);
	await applyServerlessTransitions(serverId, serverlessTransitions);

	const reportedDeploymentIds = report.containers
		.map((c) => c.deploymentId)
		.filter((id) => id !== "");

	const activeStatuses = [
		"starting",
		"healthy",
		"running",
		"stopping",
	] as const;

	const activeDeployments = await db
		.select({
			id: deployments.id,
			containerId: deployments.containerId,
			status: deployments.status,
		})
		.from(deployments)
		.where(
			and(
				eq(deployments.serverId, serverId),
				isNotNull(deployments.containerId),
				inArray(deployments.status, activeStatuses),
			),
		);

	for (const dep of activeDeployments) {
		if (!reportedDeploymentIds.includes(dep.id)) {
			if (dep.status === "stopping") {
				console.log(
					`[status:${serverId.slice(0, 8)}] deployment ${dep.id.slice(0, 8)} was stopping and container gone, deleting`,
				);
				await db
					.delete(deploymentPorts)
					.where(eq(deploymentPorts.deploymentId, dep.id));
				await db.delete(deployments).where(eq(deployments.id, dep.id));
			} else {
				console.log(
					`[status:${serverId.slice(0, 8)}] deployment ${dep.id.slice(0, 8)} NOT reported, marking UNKNOWN`,
				);
				await db
					.update(deployments)
					.set({ status: "unknown", healthStatus: null })
					.where(eq(deployments.id, dep.id));
			}
		}
	}

	for (const container of report.containers) {
		const healthStatus = container.healthStatus;

		let [deployment] = container.deploymentId
			? await db
					.select()
					.from(deployments)
					.where(eq(deployments.id, container.deploymentId))
			: await db
					.select()
					.from(deployments)
					.where(eq(deployments.containerId, container.containerId));

		if (!deployment && container.deploymentId) {
			continue;
		}

		if (!deployment) {
			const stuckStatuses = ["pending", "pulling", "waking"] as const;
			const [stuckDeployment] = await db
				.select()
				.from(deployments)
				.where(
					and(
						eq(deployments.serverId, serverId),
						isNull(deployments.containerId),
						inArray(deployments.status, stuckStatuses),
					),
				);

			if (stuckDeployment) {
				console.log(
					`[health:recover] found stuck deployment ${stuckDeployment.id}, attaching container ${container.containerId}`,
				);

				const service = await db
					.select()
					.from(services)
					.where(eq(services.id, stuckDeployment.serviceId))
					.then((r) => r[0]);

				const hasHealthCheck = service?.healthCheckCmd != null;
				const newStatus = hasHealthCheck ? "starting" : "healthy";

				await db
					.update(deployments)
					.set({
						containerId: container.containerId,
						status: newStatus,
						healthStatus: hasHealthCheck ? "starting" : "none",
						serverlessWakeFailureCount: 0,
					})
					.where(eq(deployments.id, stuckDeployment.id));

				deployment = {
					...stuckDeployment,
					status: newStatus,
					containerId: container.containerId,
					healthStatus: hasHealthCheck ? "starting" : "none",
				};

				if (!hasHealthCheck) {
					if (deployment.rolloutId) {
						await inngest.send(
							inngestEvents.resourceStatusChanged.create({
								type: "deployment",
								id: deployment.id,
								parentType: "rollout",
								parentId: deployment.rolloutId,
							}),
						);
					}

					if (isMigrationTargetStarting(service?.migrationStatus)) {
						console.log(
							`[migration] target service ${service.id} healthy, promoting`,
						);
						await completeTargetMigration(service.id);
					}
				}
			}
		}

		if (!deployment) {
			continue;
		}

		const updateFields: Record<string, unknown> = { healthStatus };
		let autohealRestartPayload: Record<string, unknown> | null = null;
		let autohealRecreatePayload: Record<string, unknown> | null = null;
		let autohealFailed = false;

		if (deployment.containerId !== container.containerId) {
			updateFields.containerId = container.containerId;
		}

		if (shouldAttachReportedContainer(deployment.status)) {
			if (container.status !== "running") {
				continue;
			}

			const service = await db
				.select()
				.from(services)
				.where(eq(services.id, deployment.serviceId))
				.then((r) => r[0]);

			const hasHealthCheck = service?.healthCheckCmd != null;
			const newStatus = hasHealthCheck ? "starting" : "healthy";
			updateFields.status = newStatus;
			if (deployment.status === "waking") {
				updateFields.serverlessWakeFailureCount = 0;
			}
			if (hasHealthCheck) {
				updateFields.healthStatus = "starting";
			}
			console.log(
				`[health:attach] deployment ${deployment.id} transitioning from ${deployment.status} to ${newStatus}`,
			);

			if (deployment.rolloutId) {
				const currentServerName = await getCurrentServerLogName();
				await ingestRolloutLog(
					deployment.rolloutId,
					deployment.serviceId,
					"deploying",
					`Starting container on server ${currentServerName}`,
				);
			}

			if (!hasHealthCheck) {
				await db
					.update(deployments)
					.set(updateFields)
					.where(eq(deployments.id, deployment.id));

				if (deployment.rolloutId) {
					await inngest.send(
						inngestEvents.resourceStatusChanged.create({
							type: "deployment",
							id: deployment.id,
							parentType: "rollout",
							parentId: deployment.rolloutId,
						}),
					);
				}

				if (isMigrationTargetStarting(service?.migrationStatus)) {
					console.log(
						`[migration] deployment ${deployment.id} healthy (no health check), promoting`,
					);
					await completeTargetMigration(deployment.serviceId);
				}
				continue;
			}
		}

		if (deployment.status === "unknown") {
			const newStatus =
				healthStatus === "healthy" || healthStatus === "none"
					? "running"
					: "starting";
			updateFields.status = newStatus;
			console.log(
				`[health:restore] deployment ${deployment.id} restored from unknown to ${newStatus}`,
			);
		}

		const canAutoheal =
			container.status === "running" &&
			(deployment.status === "running" || deployment.status === "healthy");
		const healthRecovered =
			healthStatus === "healthy" || healthStatus === "none";
		if (canAutoheal && healthRecovered) {
			await completeTargetMigration(deployment.serviceId);
		}

		if (canAutoheal && healthStatus === "unhealthy") {
			const unhealthyReportCount = (deployment.unhealthyReportCount ?? 0) + 1;
			updateFields.unhealthyReportCount = unhealthyReportCount;

			if (unhealthyReportCount >= AUTOHEAL_UNHEALTHY_REPORTS) {
				const restartCount = deployment.autohealRestartCount ?? 0;

				if (restartCount >= AUTOHEAL_MAX_RESTARTS) {
					const rollout = deployment.rolloutId
						? await db
								.select({ status: rollouts.status })
								.from(rollouts)
								.where(eq(rollouts.id, deployment.rolloutId))
								.then((r) => r[0])
						: null;
					const isRolloutDeployment = rollout?.status === "in_progress";

					if (isRolloutDeployment) {
						console.log(
							`[autoheal] rollout deployment ${deployment.id} exceeded restart limit`,
						);
						Object.assign(updateFields, markDeploymentUndesired("failed"));
						updateFields.failedStage = "autoheal";
						autohealFailed = true;
					} else {
						autohealRecreatePayload = prepareAutohealRecreatePayload({
							deployment,
							containerId: container.containerId,
							updateFields,
						});
					}
				} else {
					console.log(
						`[autoheal] restarting unhealthy deployment ${deployment.id} (${restartCount + 1}/${AUTOHEAL_MAX_RESTARTS})`,
					);
					updateFields.unhealthyReportCount = 0;
					updateFields.autohealRestartCount = restartCount + 1;
					autohealRestartPayload = {
						deploymentId: deployment.id,
						containerId: container.containerId,
						reason: "autoheal_unhealthy",
					};
				}
			}
		} else if (healthRecovered) {
			updateFields.unhealthyReportCount = 0;
			updateFields.autohealRecreateCount = 0;
		}

		await db
			.update(deployments)
			.set(updateFields)
			.where(eq(deployments.id, deployment.id));

		if (autohealRestartPayload) {
			await enqueueWork(serverId, "restart", autohealRestartPayload);
		}
		if (autohealRecreatePayload) {
			await enqueueWork(serverId, "force_cleanup", autohealRecreatePayload);
		}

		if (autohealFailed && deployment.rolloutId) {
			const currentServerName = await getCurrentServerLogName();
			await ingestRolloutLog(
				deployment.rolloutId,
				deployment.serviceId,
				"autoheal",
				`Container exceeded autoheal restart limit on server ${currentServerName}`,
			);
			await inngest.send(
				inngestEvents.resourceStatusChanged.create({
					type: "deployment",
					id: deployment.id,
					parentType: "rollout",
					parentId: deployment.rolloutId,
				}),
			);
		}

		if (
			deployment.status === "starting" &&
			container.status === "running" &&
			(healthStatus === "healthy" || healthStatus === "none")
		) {
			console.log(
				`[health] deployment ${deployment.id} is now healthy (healthStatus=${healthStatus})`,
			);

			await db
				.update(deployments)
				.set({
					status: "healthy",
					autohealRestartCount: 0,
					autohealRecreateCount: 0,
					serverlessWakeFailureCount: 0,
				})
				.where(eq(deployments.id, deployment.id));

			if (deployment.rolloutId) {
				const currentServerName = await getCurrentServerLogName();
				await ingestRolloutLog(
					deployment.rolloutId,
					deployment.serviceId,
					"health_check",
					`Container is healthy on server ${currentServerName}`,
				);
				await inngest.send(
					inngestEvents.resourceStatusChanged.create({
						type: "deployment",
						id: deployment.id,
						parentType: "rollout",
						parentId: deployment.rolloutId,
					}),
				);
			}

			const deployedService = await db
				.select({ migrationStatus: services.migrationStatus })
				.from(services)
				.where(eq(services.id, deployment.serviceId))
				.then((r) => r[0]);

			if (isMigrationTargetStarting(deployedService?.migrationStatus)) {
				console.log(
					`[migration] deployment ${deployment.id} healthy, promoting`,
				);
				await completeTargetMigration(deployment.serviceId);
			}
		}

		if (deployment.status === "starting" && healthStatus === "unhealthy") {
			console.log(`[health] deployment ${deployment.id} failed health check`);
			const rollout = deployment.rolloutId
				? await db
						.select({ status: rollouts.status })
						.from(rollouts)
						.where(eq(rollouts.id, deployment.rolloutId))
						.then((r) => r[0])
				: null;
			const isRolloutDeployment = rollout?.status === "in_progress";
			const recreateCount = deployment.autohealRecreateCount ?? 0;
			const { update, recreateLimitReached } =
				getStartingHealthCheckFailureUpdate({
					isRolloutDeployment,
					recreateCount,
				});

			await db
				.update(deployments)
				.set(update)
				.where(eq(deployments.id, deployment.id));

			if (isRolloutDeployment && deployment.rolloutId) {
				const currentServerName = await getCurrentServerLogName();
				await ingestRolloutLog(
					deployment.rolloutId,
					deployment.serviceId,
					"health_check",
					`Container failed health check on server ${currentServerName}`,
				);
				await inngest.send(
					inngestEvents.resourceStatusChanged.create({
						type: "deployment",
						id: deployment.id,
						parentType: "rollout",
						parentId: deployment.rolloutId,
					}),
				);
			}

			if (!isRolloutDeployment && !recreateLimitReached) {
				await enqueueWork(serverId, "force_cleanup", {
					reason: "autoheal_recreate",
					deploymentId: deployment.id,
					serviceId: deployment.serviceId,
					containerIds: [container.containerId],
				});
			} else if (recreateLimitReached) {
				console.log(
					`[autoheal] deployment ${deployment.id} exceeded recreate limit`,
				);
			}
		}
	}

	if (report.dnsInSync) {
		const rolloutsInDnsSync = await db
			.select({ id: rollouts.id })
			.from(rollouts)
			.where(
				and(
					eq(rollouts.status, "in_progress"),
					eq(rollouts.currentStage, "dns_sync"),
				),
			);

		for (const rollout of rolloutsInDnsSync) {
			const currentServerName = await getCurrentServerLogName();
			await ingestRolloutLog(
				rollout.id,
				"",
				"dns_sync",
				`DNS synced on server ${currentServerName}`,
			);
			await inngest.send(
				inngestEvents.serverDnsSynced.create({
					serverId,
					rolloutId: rollout.id,
				}),
			);
		}
	}
}

function prepareAutohealRecreatePayload({
	deployment,
	containerId,
	updateFields,
}: {
	deployment: typeof deployments.$inferSelect;
	containerId: string;
	updateFields: Record<string, unknown>;
}): Record<string, unknown> | null {
	const decision = getSteadyStateRecreateDecision({ deployment, containerId });
	Object.assign(updateFields, decision.updateFields);

	if (decision.limitReached) {
		console.log(
			`[autoheal] deployment ${deployment.id} exceeded recreate limit`,
		);
		return null;
	}

	console.log(
		`[autoheal] recreating steady-state deployment ${deployment.id} after restart limit (${(deployment.autohealRecreateCount ?? 0) + 1}/${AUTOHEAL_MAX_RECREATES})`,
	);
	return decision.cleanupPayload;
}
