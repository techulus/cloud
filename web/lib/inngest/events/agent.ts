import type { StatusReport } from "@/lib/agent-status";

export type AgentEvents = {
	"agent/status-reported": {
		data: {
			serverId: string;
			report: StatusReport;
		};
	};
};
