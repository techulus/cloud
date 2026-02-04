import { inngest } from "../client";
import { applyStatusReport } from "@/lib/agent-status";

export const processAgentStatus = inngest.createFunction(
	{
		id: "process-agent-status",
		concurrency: [{ limit: 5, key: "event.data.serverId" }],
	},
	{ event: "agent/status-reported" },
	async ({ event }) => {
		const { serverId, report } = event.data;
		await applyStatusReport(serverId, report);
	},
);
