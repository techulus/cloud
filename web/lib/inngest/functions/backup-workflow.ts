import { eq } from "drizzle-orm";
import { db } from "@/db";
import { volumeBackups } from "@/db/schema";
import { inngest } from "../client";
import { inngestEvents } from "../events";

export const backupWorkflow = inngest.createFunction(
	{
		id: "backup-workflow",
		triggers: [inngestEvents.backupStarted],
	},
	async ({ event, step, group }) => {
		const { backupId } = event.data;

		const outcome = await group.parallel(() => {
			const completedPromise = step
				.waitForEvent("wait-backup-completed", {
					event: inngestEvents.backupCompleted,
					timeout: "30m",
					if: `async.data.backupId == "${backupId}"`,
				})
				.then((result) => ({ status: "completed" as const, result }));

			const failedPromise = step
				.waitForEvent("wait-backup-failed", {
					event: inngestEvents.backupFailed,
					timeout: "30m",
					if: `async.data.backupId == "${backupId}"`,
				})
				.then((result) => ({ status: "failed" as const, result }));

			return Promise.race([completedPromise, failedPromise]);
		});

		if (!outcome.result) {
			await step.run("handle-backup-timeout", async () => {
				await db
					.update(volumeBackups)
					.set({
						status: "failed",
						errorMessage: "Backup timed out after 30 minutes",
					})
					.where(eq(volumeBackups.id, backupId));
			});

			return { status: "failed", reason: "timeout", backupId };
		}

		if (outcome.status === "failed") {
			return {
				status: "failed",
				reason: outcome.result.data.error || "backup_failed",
				backupId,
			};
		}

		return { status: "completed", backupId };
	},
);

export const onBackupFailed = inngest.createFunction(
	{
		id: "on-backup-failed",
		triggers: [inngestEvents.backupFailed],
	},
	async ({ event }) => {
		const { backupId, error } = event.data;
		return { status: "failed", backupId, error };
	},
);
