export function buildRoutingTargets({
	workloadServerIds,
	proxyServerIds,
	isPublic,
}: {
	workloadServerIds: string[];
	proxyServerIds: string[];
	isPublic: boolean;
}) {
	return [
		...new Set([...workloadServerIds, ...(isPublic ? proxyServerIds : [])]),
	];
}

export function isRoutingSyncAcknowledgementEligible(
	rollout: {
		status: string;
		currentStage: string | null;
		routingTargets: string[];
	},
	serverId: string,
) {
	return (
		rollout.status === "in_progress" &&
		rollout.currentStage === "dns_sync" &&
		rollout.routingTargets.includes(serverId)
	);
}
