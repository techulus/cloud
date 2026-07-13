import type { AgentHealth } from "@/db/schema";

export const SERVICE_REVISION_CAPABILITY = "service_revision_v1";

export type AgentCompatibilityStatus = "compatible" | "upgrade_required";

export function getAgentCompatibilityStatus(
	agentHealth: AgentHealth | null | undefined,
): AgentCompatibilityStatus {
	return agentHealth?.capabilities?.includes(SERVICE_REVISION_CAPABILITY)
		? "compatible"
		: "upgrade_required";
}
