import { inngest } from "../client";

export const restoreWorkflow = inngest.createFunction(
	{
		id: "restore-workflow",
	},
	{ event: "restore/started" },
	async ({ event, step }) => {
		const { backupId } = event.data;

		const result = await step.waitForEvent("wait-restore-completed", {
			event: "restore/completed",
			timeout: "30m",
			if: `async.data.backupId == "${backupId}"`,
		});

		if (!result) {
			return { status: "failed", reason: "timeout", backupId };
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
