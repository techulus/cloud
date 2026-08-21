import { inngest } from "@/lib/inngest/client";
import { reportServerError } from "@/lib/server-errors";

export const sentryFailureWorkflow = inngest.createFunction(
	{
		id: "sentry-function-failure",
		triggers: [{ event: "inngest/function.failed" }],
	},
	async ({ event }) => {
		const error = new Error(event.data.error.message);
		error.name = event.data.error.name;
		error.stack = event.data.error.stack;

		reportServerError(error, "inngest.function.failed", {
			tags: { functionId: event.data.function_id },
			extra: { runId: event.data.run_id },
		});
	},
);
