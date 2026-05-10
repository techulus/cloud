import { inngest } from "../client";
import { inngestEvents } from "../events";

export const restoreWorkflow = inngest.createFunction(
	{
		id: "restore-workflow",
		triggers: [inngestEvents.restoreStarted],
	},
	async ({ event, step, group }) => {
		const { backupId } = event.data;

		const outcome = await group.parallel(() => {
			const completedPromise = step
				.waitForEvent("wait-restore-completed", {
					event: inngestEvents.restoreCompleted,
					timeout: "30m",
					if: `async.data.backupId == "${backupId}"`,
				})
				.then((result) => ({ status: "completed" as const, result }));

			const failedPromise = step
				.waitForEvent("wait-restore-failed", {
					event: inngestEvents.restoreFailed,
					timeout: "30m",
					if: `async.data.backupId == "${backupId}"`,
				})
				.then((result) => ({ status: "failed" as const, result }));

			return Promise.race([completedPromise, failedPromise]);
		});

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
		triggers: [inngestEvents.restoreFailed],
	},
	async ({ event, step }) => {
		const { backupId, error } = event.data;
		return { status: "failed", backupId, error };
	},
);
