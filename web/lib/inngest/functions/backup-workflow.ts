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

		const initialBackup = await step.run("check-backup-before-wait", async () => {
			return db
				.select({
					status: volumeBackups.status,
					errorMessage: volumeBackups.errorMessage,
				})
				.from(volumeBackups)
				.where(eq(volumeBackups.id, backupId))
				.then((r) => r[0]);
		});

		if (initialBackup?.status === "completed") {
			return { status: "completed", backupId };
		}

		if (initialBackup?.status === "failed") {
			return {
				status: "failed",
				reason: initialBackup.errorMessage || "backup_failed",
				backupId,
			};
		}

		const wakeup = await group.parallel(() =>
			step.waitForEvent("wait-backup-status-changed", {
				event: inngestEvents.resourceStatusChanged,
				timeout: "30m",
				if: `async.data.type == "backup" && async.data.id == "${backupId}"`,
			}),
		);

		const backup = await step.run("check-backup-after-wait", async () => {
			return db
				.select({
					status: volumeBackups.status,
					errorMessage: volumeBackups.errorMessage,
				})
				.from(volumeBackups)
				.where(eq(volumeBackups.id, backupId))
				.then((r) => r[0]);
		});

		if (backup?.status === "completed") {
			return { status: "completed", backupId };
		}

		if (backup?.status === "failed") {
			return {
				status: "failed",
				reason: backup.errorMessage || "backup_failed",
				backupId,
			};
		}

		if (!wakeup) {
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

		return { status: "pending", backupId };
	},
);
