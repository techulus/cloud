import { inngest } from "../client";

export const restoreWorkflow = inngest.createFunction(
	{
		id: "restore-workflow",
	},
	{ event: "restore/started" },
	async ({ event, step }) => {
		const { backupId } = event.data;

		const completedPromise = step
			.waitForEvent("wait-restore-completed", {
				event: "restore/completed",
				timeout: "30m",
				if: `async.data.backupId == "${backupId}"`,
			})
			.then((result) => ({ status: "completed" as const, result }));

		const failedPromise = step
			.waitForEvent("wait-restore-failed", {
				event: "restore/failed",
				timeout: "30m",
				if: `async.data.backupId == "${backupId}"`,
			})
			.then((result) => ({ status: "failed" as const, result }));

		const outcome = await Promise.race([completedPromise, failedPromise]);

		if (!outcome.result) {
			return { status: "failed", reason: "timeout", backupId };
		}

		if (outcome.status === "failed") {
			return {
				status: "failed",
				reason: outcome.result.data.error || "restore_failed",
				backupId,
			};
		}

		return { status: "completed", backupId };
	},
);

export const onRestoreFailed = inngest.createFunction(
	{
		id: "on-restore-failed",
	},
	{ event: "restore/failed" },
	async ({ event, step }) => {
		const { backupId, error } = event.data;
		return { status: "failed", backupId, error };
	},
);
