import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deployments, rollouts } from "@/db/schema";
import { ingestRolloutLog } from "@/lib/victoria-logs";
import { inngest } from "../client";
import { inngestEvents } from "../events";
import { handleRolloutFailure } from "./rollout-utils";

export const onDeploymentFailed = inngest.createFunction(
	{ id: "on-deployment-failed", triggers: [inngestEvents.resourceStatusChanged] },
	async ({ event, step }) => {
		if (event.data.type !== "deployment") return;

		const deployment = await step.run("get-deployment", async () => {
			return db
				.select({
					id: deployments.id,
					rolloutId: deployments.rolloutId,
					serviceId: deployments.serviceId,
					observedPhase: deployments.observedPhase,
					failedStage: deployments.failedStage,
				})
				.from(deployments)
				.where(eq(deployments.id, event.data.id))
				.then((r) => r[0]);
		});

		if (
			!deployment?.rolloutId ||
			deployment.observedPhase !== "failed"
		) {
			return;
		}

		const { rolloutId, serviceId } = deployment;
		const reason = deployment.failedStage || "deployment_failed";

		const rollout = await step.run("get-rollout", async () => {
			return db
				.select()
				.from(rollouts)
				.where(eq(rollouts.id, rolloutId))
				.then((r) => r[0]);
		});

		if (!rollout || rollout.status !== "in_progress") return;

		await ingestRolloutLog(
			rolloutId,
			serviceId,
			reason,
			`Rollout failed: ${reason}`,
		);

		await step.sendEvent(
			"cancel-rollout",
			inngestEvents.rolloutCancelled.create({ rolloutId }),
		);

		await step.run("handle-failure", async () => {
			await handleRolloutFailure(rolloutId, serviceId, reason, true);
		});
	},
);
