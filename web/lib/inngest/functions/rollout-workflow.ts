import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments, rollouts } from "@/db/schema";
import { inngest } from "../client";
import { handleRolloutFailure } from "./rollout-utils";

export const rolloutWorkflow = inngest.createFunction(
	{
		id: "rollout-workflow",
		cancelOn: [{ event: "rollout/cancelled", match: "data.rolloutId" }],
	},
	{ event: "rollout/created" },
	async ({ event, step }) => {
		const { rolloutId, serviceId, deploymentIds, serverIds, isRollingUpdate } =
			event.data;

		await step.run("start-health-check", async () => {
			await db
				.update(rollouts)
				.set({ currentStage: "health_check" })
				.where(eq(rollouts.id, rolloutId));
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

		dnsResults.forEach((result, index) => {
			if (result === null) {
				console.warn(
					`[rollout:${rolloutId}] DNS sync timeout for server ${serverIds[index]}`,
				);
			}
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
		});

		return { status: "completed", rolloutId };
	},
);
