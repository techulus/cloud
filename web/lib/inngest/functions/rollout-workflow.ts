import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments, rollouts } from "@/db/schema";
import { getService } from "@/db/queries";
import { inngest } from "../client";
import { handleRolloutFailure } from "./rollout-utils";
import { ingestRolloutLog } from "@/lib/victoria-logs";
import {
	calculateServicePlacements,
	validateServers,
	prepareRollingUpdate,
	cleanupExistingDeployments,
	issueCertificatesForService,
	createDeploymentRecords,
	saveDeployedConfig,
	checkForRollingUpdate,
} from "./rollout-helpers";

export const rolloutWorkflow = inngest.createFunction(
	{
		id: "rollout-workflow",
		concurrency: [{ limit: 1, key: "event.data.serviceId" }],
		cancelOn: [{ event: "rollout/cancelled", match: "data.rolloutId" }],
	},
	{ event: "rollout/created" },
	async ({ event, step }) => {
		const { rolloutId, serviceId } = event.data;

		await step.run("validate-service", async () => {
			const svc = await getService(serviceId);
			if (!svc) {
				throw new Error("Service not found");
			}
		});

		await step.run("mark-rollout-in-progress", async () => {
			await db
				.update(rollouts)
				.set({ status: "in_progress", currentStage: "preparing" })
				.where(eq(rollouts.id, rolloutId));
			await ingestRolloutLog(
				rolloutId,
				serviceId,
				"preparing",
				"Rollout started",
			);
		});

		const { placements, totalReplicas } = await step.run(
			"calculate-placements",
			async () => {
				const service = await getService(serviceId);
				if (!service) {
					throw new Error("Service not found");
				}
				const result = await calculateServicePlacements(service);
				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"preparing",
					`Calculated placements: ${result.totalReplicas} replica(s)`,
				);
				return result;
			},
		);

		const serverIds = await step.run("validate-servers", async () => {
			const serverMap = await validateServers(placements);
			const ids = [...serverMap.keys()];
			await ingestRolloutLog(
				rolloutId,
				serviceId,
				"preparing",
				`Validated ${ids.length} server(s)`,
			);
			return ids;
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
				await cleanupExistingDeployments(serviceId);
				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"preparing",
					"Cleaned up existing deployments",
				);
			});
		}

		const certResult = await step.run("issue-certificates", async () => {
			await db
				.update(rollouts)
				.set({ currentStage: "certificates" })
				.where(eq(rollouts.id, rolloutId));
			try {
				await issueCertificatesForService(serviceId);
				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"certificates",
					"Certificates issued",
				);
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

		await step.run("start-health-check", async () => {
			await db
				.update(rollouts)
				.set({ currentStage: "health_check" })
				.where(eq(rollouts.id, rolloutId));
			await ingestRolloutLog(
				rolloutId,
				serviceId,
				"health_check",
				"Waiting for health checks",
			);
		});

		const healthResults = await Promise.all(
			deploymentIds.map((deploymentId) =>
				step.waitForEvent(`wait-healthy-${deploymentId}`, {
					event: "deployment/healthy",
					timeout: "10m",
					if: `async.data.deploymentId == "${deploymentId}"`,
				}),
			),
		);

		const timedOutIndex = healthResults.indexOf(null);
		if (timedOutIndex !== -1) {
			const failedDeploymentId = deploymentIds[timedOutIndex];
			await step.run("log-health-timeout", async () => {
				await ingestRolloutLog(
					rolloutId,
					serviceId,
					"health_check",
					`Health check timed out for deployment ${failedDeploymentId}`,
				);
			});
			await step.run("handle-health-timeout", async () => {
				await handleRolloutFailure(
					rolloutId,
					serviceId,
					"health_check_timeout",
					isRollingUpdate,
				);
			});
			return {
				status: "failed",
				reason: "health_check_timeout",
				deploymentId: failedDeploymentId,
			};
		}

		await step.run("start-dns-sync", async () => {
			await db
				.update(rollouts)
				.set({ currentStage: "dns_sync" })
				.where(eq(rollouts.id, rolloutId));

			await db
				.update(deployments)
				.set({ status: "stopping" })
				.where(
					and(
						eq(deployments.serviceId, serviceId),
						eq(deployments.status, "draining"),
					),
				);

			await db
				.update(deployments)
				.set({ status: "running" })
				.where(
					and(
						eq(deployments.rolloutId, rolloutId),
						eq(deployments.status, "healthy"),
					),
				);

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
					event: "server/dns-synced",
					timeout: "5m",
					if: `async.data.serverId == "${serverId}" && async.data.rolloutId == "${rolloutId}"`,
				}),
			),
		);

		for (let i = 0; i < dnsResults.length; i++) {
			if (dnsResults[i] === null) {
				console.warn(
					`[rollout:${rolloutId}] DNS sync timeout for server ${serverIds[i]}`,
				);
				await step.run(`log-dns-timeout-${serverIds[i]}`, async () => {
					await ingestRolloutLog(
						rolloutId,
						serviceId,
						"dns_sync",
						`DNS sync timed out for server ${serverIds[i]}`,
					);
				});
			}
		}

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
