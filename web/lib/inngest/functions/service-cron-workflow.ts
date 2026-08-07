import { executeServiceCron } from "@/lib/service-crons";
import { inngest } from "../client";
import { inngestEvents } from "../events";

export const serviceCronWorkflow = inngest.createFunction(
	{
		id: "service-cron-execute",
		retries: 0,
		concurrency: [{ limit: 1, key: "event.data.cronId" }],
		triggers: [inngestEvents.serviceCronExecute],
	},
	async ({ event, step }) =>
		step.run("execute-service-cron", () =>
			executeServiceCron(
				event.data.cronId,
				event.data.schedule,
				new Date(event.data.scheduledFor),
				event.data.source,
			),
		),
);
