import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { rollouts } from "@/db/schema";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { reportOperationFailure } from "@/lib/server-errors";

export async function sendRolloutCreated(
	rolloutId: string,
	serviceId: string,
): Promise<void> {
	try {
		await inngest.send(
			inngestEvents.rolloutCreated.create(
				{ rolloutId, serviceId },
				{ id: `rollout-created-${rolloutId}` },
			),
		);
	} catch (error) {
		const failed = await db
			.update(rollouts)
			.set({
				status: "failed",
				currentStage: "enqueue_failed",
				completedAt: new Date(),
			})
			.where(and(eq(rollouts.id, rolloutId), eq(rollouts.status, "queued")))
			.returning({ serviceRevisionId: rollouts.serviceRevisionId })
			.then((rows) => rows[0]);
		if (failed) {
			reportOperationFailure("rollout.failed", {
				occurrenceId: rolloutId,
				reason: "enqueue_failed",
				tags: {
					rolloutId,
					serviceId,
					...(failed.serviceRevisionId
						? { revisionId: failed.serviceRevisionId }
						: {}),
					failureStage: "enqueue_failed",
					rollbackState: "failed",
				},
			});
		}
		throw error;
	}
}
