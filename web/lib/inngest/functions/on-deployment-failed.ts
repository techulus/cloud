import { eq } from "drizzle-orm";
import { db } from "@/db";
import { rollouts } from "@/db/schema";
import { inngest } from "../client";
import { inngestEvents } from "../events";
import { handleRolloutFailure } from "./rollout-utils";
import { ingestRolloutLog } from "@/lib/victoria-logs";

export const onDeploymentFailed = inngest.createFunction(
	{ id: "on-deployment-failed", triggers: [inngestEvents.deploymentFailed] },
	async ({ event, step }) => {
		const { rolloutId, serviceId, reason } = event.data;

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
