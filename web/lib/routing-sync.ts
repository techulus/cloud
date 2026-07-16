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

export function selectRoutingSyncRolloutIds({
	rollouts,
	runtimeServices,
	serverId,
}: {
	rollouts: Array<{
		id: string;
		serviceId: string;
		serviceRevisionId: string | null;
		routingTargets: string[];
	}>;
	runtimeServices: Array<{ id: string; revisionId: string }>;
	serverId: string;
}) {
	const runtimeRevisionByServiceId = new Map(
		runtimeServices.map((service) => [service.id, service.revisionId]),
	);

	return rollouts
		.filter(
			(rollout) =>
				rollout.routingTargets.includes(serverId) &&
				rollout.serviceRevisionId !== null &&
				runtimeRevisionByServiceId.get(rollout.serviceId) ===
					rollout.serviceRevisionId,
		)
		.map((rollout) => rollout.id);
}
