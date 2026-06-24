import type { deployments } from "@/db/schema";

export type DeploymentStatus = typeof deployments.$inferSelect.status;

export type UndesiredDeploymentStatus = Extract<
	DeploymentStatus,
	"stopping" | "stopped" | "failed" | "rolled_back"
>;

type DeploymentStatusCapabilities = {
	expected: boolean;
	routable: boolean;
	dns: boolean;
};

const deploymentStatusCapabilities = {
	pending: { expected: true, routable: false, dns: false },
	pulling: { expected: true, routable: false, dns: false },
	starting: { expected: true, routable: false, dns: false },
	healthy: { expected: true, routable: true, dns: true },
	running: { expected: true, routable: true, dns: true },
	draining: { expected: true, routable: false, dns: false },
	stopping: { expected: false, routable: false, dns: false },
	stopped: { expected: false, routable: false, dns: false },
	failed: { expected: false, routable: false, dns: false },
	rolled_back: { expected: false, routable: false, dns: false },
	unknown: { expected: true, routable: false, dns: false },
} satisfies Record<DeploymentStatus, DeploymentStatusCapabilities>;

export const expectedDeploymentStatuses = statusesWithCapability("expected");
export const routableDeploymentStatuses = statusesWithCapability("routable");
export const dnsDeploymentStatuses = statusesWithCapability("dns");

export function markDeploymentUndesired(status: UndesiredDeploymentStatus) {
	return { status, desired: false };
}

function statusesWithCapability(capability: keyof DeploymentStatusCapabilities) {
	return Object.entries(deploymentStatusCapabilities)
		.filter(([, capabilities]) => capabilities[capability])
		.map(([status]) => status as DeploymentStatus);
}
