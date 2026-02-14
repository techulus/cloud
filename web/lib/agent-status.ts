import { db } from "@/db";
import {
	deployments,
	deploymentPorts,
	servers,
	services,
	rollouts,
	type HealthStats,
	type NetworkHealth,
	type ContainerHealth,
	type AgentHealth,
} from "@/db/schema";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { inngest } from "@/lib/inngest/client";
import { ingestRolloutLog } from "@/lib/victoria-logs";

type ContainerStatus = {
	deploymentId: string;
	containerId: string;
	status: "running" | "stopped" | "failed";
	healthStatus: "none" | "starting" | "healthy" | "unhealthy";
};

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
	healthStats?: HealthStats;
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

	if (report.healthStats) {
		updateData.healthStats = report.healthStats;
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
						await inngest.send({
							name: "deployment/healthy",
							data: {
								deploymentId: deployment.id,
								rolloutId: deployment.rolloutId,
								serviceId: deployment.serviceId,
							},
						});
					}

					if (service?.migrationStatus === "deploying_target") {
						console.log(
							`[migration] target service ${service.id} healthy, promoting`,
						);
						await db
							.update(services)
							.set({
								migrationStatus: null,
								migrationTargetServerId: null,
							})
							.where(eq(services.id, service.id));
					}
				}
			}
		}

		if (!deployment) {
			continue;
		}

		const updateFields: Record<string, unknown> = { healthStatus };
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
				await ingestRolloutLog(
					deployment.rolloutId,
					deployment.serviceId,
					"deploying",
					`Deployment ${deployment.id} starting on server ${serverId}`,
				);
			}

			if (!hasHealthCheck) {
				await db
					.update(deployments)
					.set(updateFields)
					.where(eq(deployments.id, deployment.id));

				if (deployment.rolloutId) {
					await inngest.send({
						name: "deployment/healthy",
						data: {
							deploymentId: deployment.id,
							rolloutId: deployment.rolloutId,
							serviceId: deployment.serviceId,
						},
					});
				}

				if (service?.migrationStatus === "deploying_target") {
					console.log(
						`[migration] deployment ${deployment.id} healthy (no health check), sending event`,
					);
					await inngest.send({
						name: "migration/deployment-healthy",
						data: {
							deploymentId: deployment.id,
							serviceId: deployment.serviceId,
						},
					});
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

		await db
			.update(deployments)
			.set(updateFields)
			.where(eq(deployments.id, deployment.id));

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
				.set({ status: "healthy" })
				.where(eq(deployments.id, deployment.id));

			if (deployment.rolloutId) {
				await ingestRolloutLog(
					deployment.rolloutId,
					deployment.serviceId,
					"health_check",
					`Deployment ${deployment.id} is healthy`,
				);
				await inngest.send({
					name: "deployment/healthy",
					data: {
						deploymentId: deployment.id,
						rolloutId: deployment.rolloutId,
						serviceId: deployment.serviceId,
					},
				});
			}

			const deployedService = await db
				.select({ migrationStatus: services.migrationStatus })
				.from(services)
				.where(eq(services.id, deployment.serviceId))
				.then((r) => r[0]);

			if (deployedService?.migrationStatus === "deploying_target") {
				console.log(
					`[migration] deployment ${deployment.id} healthy, sending event`,
				);
				await inngest.send({
					name: "migration/deployment-healthy",
					data: {
						deploymentId: deployment.id,
						serviceId: deployment.serviceId,
					},
				});
			}
		}

		if (deployment.status === "starting" && healthStatus === "unhealthy") {
			console.log(`[health] deployment ${deployment.id} failed health check`);

			await db
				.update(deployments)
				.set({ status: "failed", failedStage: "health_check" })
				.where(eq(deployments.id, deployment.id));

			if (deployment.rolloutId) {
				await ingestRolloutLog(
					deployment.rolloutId,
					deployment.serviceId,
					"health_check",
					`Deployment ${deployment.id} failed health check`,
				);
				await inngest.send({
					name: "deployment/failed",
					data: {
						deploymentId: deployment.id,
						rolloutId: deployment.rolloutId,
						serviceId: deployment.serviceId,
						reason: "health_check_failed",
					},
				});
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
			await ingestRolloutLog(
				rollout.id,
				"",
				"dns_sync",
				`DNS synced on server ${serverId}`,
			);
			await inngest.send({
				name: "server/dns-synced",
				data: {
					serverId,
					rolloutId: rollout.id,
				},
			});
		}
	}
}
