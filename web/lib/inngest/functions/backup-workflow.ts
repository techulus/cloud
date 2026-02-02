import { eq } from "drizzle-orm";
import { db } from "@/db";
import { volumeBackups } from "@/db/schema";
import { inngest } from "../client";

export const backupWorkflow = inngest.createFunction(
	{
		id: "backup-workflow",
	},
	{ event: "backup/started" },
	async ({ event, step }) => {
		const { backupId } = event.data;

		const result = await step.waitForEvent("wait-backup-completed", {
			event: "backup/completed",
			timeout: "30m",
			if: `async.data.backupId == "${backupId}"`,
		});

		if (!result) {
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

		return { status: "completed", backupId };
	},
);

export const onBackupFailed = inngest.createFunction(
	{
		id: "on-backup-failed",
	},
	{ event: "backup/failed" },
	async ({ event }) => {
		const { backupId, error } = event.data;
		return { status: "failed", backupId, error };
	},
);
