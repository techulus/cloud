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
import { ingestRolloutLog } from "@/lib/victoria-logs";
import { enqueueWork } from "@/lib/work-queue";

type ContainerStatus = {
	deploymentId: string;
	containerId: string;
	status: "running" | "stopped" | "failed";
	healthStatus: "none" | "starting" | "healthy" | "unhealthy";
};

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
};

export async function applyStatusReport(
	serverId: string,
	report: StatusReport,
) {
	const updateData: Record<string, unknown> = {
		lastHeartbeat: new Date(),
		status: "online",
	};

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
	}

	await db.update(servers).set(updateData).where(eq(servers.id, serverId));

	let serverLogName: string | undefined;
	const getCurrentServerLogName = async () => {
		serverLogName ??= await getServerLogName(serverId);
		return serverLogName;
	};

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
			const stuckStatuses = ["pending", "pulling"] as const;
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

		if (deployment.status === "pending" || deployment.status === "pulling") {
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
