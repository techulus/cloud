import { createHash } from "node:crypto";

export type PlacementResult = { serverId: string; count: number }[];

export type PlacementServerSnapshot = {
	id: string;
	status: string;
	wireguardIp: string | null;
	resourcesCpu: number | null;
	resourcesMemory: number | null;
	resourcesDisk: number | null;
	healthStats?: {
		cpuUsagePercent: number;
		memoryUsagePercent: number;
		memoryUsedMb: number;
		diskUsagePercent: number;
		diskUsedGb: number;
	} | null;
	containerHealth?: {
		runtimeResponsive: boolean;
		runningContainers: number;
		stoppedContainers: number;
		storageUsedGb: number;
	} | null;
};

export type ReplicaAllocationSnapshot = {
	serverId: string;
	serviceId: string;
	resourceCpuLimit: number | null;
	resourceMemoryLimitMb: number | null;
	count: number;
};

export type PlacementPlanInput = {
	serviceId: string;
	totalReplicas: number;
	resourceCpuLimit: number | null;
	resourceMemoryLimitMb: number | null;
	servers: PlacementServerSnapshot[];
	existingReplicas: ReplicaAllocationSnapshot[];
	excludeServerIds?: string[];
};

type ProjectedServerLoad = {
	cpu: number;
	memoryMb: number;
	existingReplicas: number;
	assignedServiceReplicas: number;
};

type CandidateScore = {
	server: PlacementServerSnapshot;
	score: number;
	hashScore: number;
};

const EPSILON = 0.000001;
const DOMINANT_UTILIZATION_WEIGHT = 100;
const LIVE_CPU_PRESSURE_WEIGHT = 20;
const LIVE_MEMORY_PRESSURE_WEIGHT = 20;
const LIVE_DISK_PRESSURE_WEIGHT = 15;
const EXISTING_REPLICA_WEIGHT = 2;
const RUNNING_CONTAINER_WEIGHT = 0.5;
const UNRESPONSIVE_RUNTIME_PENALTY = 100;

export function calculateResourceAwarePlacementFromSnapshot({
	serviceId,
	totalReplicas,
	resourceCpuLimit,
	resourceMemoryLimitMb,
	servers,
	existingReplicas,
	excludeServerIds,
}: PlacementPlanInput): PlacementResult {
	if (totalReplicas < 1) {
		throw new Error("At least one replica is required");
	}

	const excludedIds = new Set(excludeServerIds ?? []);
	const eligibleServers = servers.filter(
		(server) =>
			server.status === "online" &&
			server.wireguardIp !== null &&
			!excludedIds.has(server.id),
	);

	if (eligibleServers.length === 0) {
		throw new Error("No healthy servers available for placement");
	}

	const projectedLoad = buildInitialProjectedLoad(
		serviceId,
		eligibleServers,
		existingReplicas,
	);
	const assignments: string[] = [];

	for (let replicaIndex = 0; replicaIndex < totalReplicas; replicaIndex++) {
		const fittingCandidates = eligibleServers.filter((server) =>
			canFit(server, getProjectedLoad(projectedLoad, server.id), {
				resourceCpuLimit,
				resourceMemoryLimitMb,
			}),
		);

		if (fittingCandidates.length === 0) {
			throw new Error(
				"No eligible servers have enough resources for placement",
			);
		}

		const unassignedCandidates = fittingCandidates.filter(
			(server) =>
				getProjectedLoad(projectedLoad, server.id).assignedServiceReplicas ===
				0,
		);
		const candidates =
			unassignedCandidates.length > 0
				? unassignedCandidates
				: fittingCandidates;

		const rankedCandidates = candidates
			.map((server) => ({
				server,
				score: scoreServer(server, getProjectedLoad(projectedLoad, server.id), {
					resourceCpuLimit,
					resourceMemoryLimitMb,
				}),
				hashScore: rendezvousHashScore(serviceId, replicaIndex, server.id),
			}))
			.sort(compareCandidates);

		const selected = rankedCandidates[0].server;
		assignments.push(selected.id);

		const selectedLoad = getProjectedLoad(projectedLoad, selected.id);
		selectedLoad.cpu += resourceCpuLimit ?? 0;
		selectedLoad.memoryMb += resourceMemoryLimitMb ?? 0;
		selectedLoad.existingReplicas += 1;
		selectedLoad.assignedServiceReplicas += 1;
	}

	return groupAssignments(assignments);
}

function buildInitialProjectedLoad(
	serviceId: string,
	servers: PlacementServerSnapshot[],
	existingReplicas: ReplicaAllocationSnapshot[],
) {
	const projectedLoad = new Map<string, ProjectedServerLoad>();
	const eligibleServerIds = new Set(servers.map((server) => server.id));

	for (const server of servers) {
		projectedLoad.set(server.id, {
			cpu: 0,
			memoryMb: 0,
			existingReplicas: 0,
			assignedServiceReplicas: 0,
		});
	}

	for (const replica of existingReplicas) {
		if (
			replica.serviceId === serviceId ||
			!eligibleServerIds.has(replica.serverId)
		) {
			continue;
		}

		const count = Math.max(0, replica.count);
		const load = getProjectedLoad(projectedLoad, replica.serverId);
		load.cpu += (replica.resourceCpuLimit ?? 0) * count;
		load.memoryMb += (replica.resourceMemoryLimitMb ?? 0) * count;
		load.existingReplicas += count;
	}

	return projectedLoad;
}

function getProjectedLoad(
	projectedLoad: Map<string, ProjectedServerLoad>,
	serverId: string,
) {
	const load = projectedLoad.get(serverId);
	if (!load) {
		throw new Error(`Missing projected load for server ${serverId}`);
	}
	return load;
}

function canFit(
	server: PlacementServerSnapshot,
	load: ProjectedServerLoad,
	request: Pick<
		PlacementPlanInput,
		"resourceCpuLimit" | "resourceMemoryLimitMb"
	>,
) {
	const cpuCapacity = server.resourcesCpu;
	const memoryCapacity = server.resourcesMemory;
	const hasKnownCpuCapacity = cpuCapacity !== null && cpuCapacity > 0;
	const hasKnownMemoryCapacity = memoryCapacity !== null && memoryCapacity > 0;

	if (
		request.resourceCpuLimit !== null &&
		hasKnownCpuCapacity &&
		load.cpu + request.resourceCpuLimit > cpuCapacity + EPSILON
	) {
		return false;
	}

	if (
		request.resourceMemoryLimitMb !== null &&
		hasKnownMemoryCapacity &&
		load.memoryMb + request.resourceMemoryLimitMb > memoryCapacity + EPSILON
	) {
		return false;
	}

	return true;
}

function scoreServer(
	server: PlacementServerSnapshot,
	load: ProjectedServerLoad,
	request: Pick<
		PlacementPlanInput,
		"resourceCpuLimit" | "resourceMemoryLimitMb"
	>,
) {
	const projectedCpu =
		load.cpu +
		(request.resourceCpuLimit === null ? 0 : request.resourceCpuLimit);
	const projectedMemoryMb =
		load.memoryMb +
		(request.resourceMemoryLimitMb === null
			? 0
			: request.resourceMemoryLimitMb);

	const cpuCapacity = server.resourcesCpu;
	const memoryCapacity = server.resourcesMemory;
	const cpuUtilization =
		cpuCapacity !== null && cpuCapacity > 0 ? projectedCpu / cpuCapacity : 0;
	const memoryUtilization =
		memoryCapacity !== null && memoryCapacity > 0
			? projectedMemoryMb / memoryCapacity
			: 0;
	const dominantUtilization = Math.max(cpuUtilization, memoryUtilization);

	const liveCpuPressure = percentToRatio(server.healthStats?.cpuUsagePercent);
	const liveMemoryPressure = percentToRatio(
		server.healthStats?.memoryUsagePercent,
	);
	const liveDiskPressure = percentToRatio(server.healthStats?.diskUsagePercent);
	const runtimePenalty =
		server.containerHealth?.runtimeResponsive === false
			? UNRESPONSIVE_RUNTIME_PENALTY
			: 0;
	const containerCountPenalty =
		(server.containerHealth?.runningContainers ?? 0) * RUNNING_CONTAINER_WEIGHT;

	return (
		dominantUtilization * DOMINANT_UTILIZATION_WEIGHT +
		liveCpuPressure * LIVE_CPU_PRESSURE_WEIGHT +
		liveMemoryPressure * LIVE_MEMORY_PRESSURE_WEIGHT +
		liveDiskPressure * LIVE_DISK_PRESSURE_WEIGHT +
		load.existingReplicas * EXISTING_REPLICA_WEIGHT +
		containerCountPenalty +
		runtimePenalty
	);
}

function percentToRatio(value: number | undefined) {
	if (value === undefined || Number.isNaN(value)) return 0;
	return Math.max(0, value) / 100;
}

function rendezvousHashScore(
	serviceId: string,
	replicaIndex: number,
	serverId: string,
) {
	const digest = createHash("sha256")
		.update(`${serviceId}:${replicaIndex}:${serverId}`)
		.digest("hex")
		.slice(0, 12);
	return Number.parseInt(digest, 16);
}

function compareCandidates(a: CandidateScore, b: CandidateScore) {
	if (Math.abs(a.score - b.score) > EPSILON) {
		return a.score - b.score;
	}

	if (a.hashScore !== b.hashScore) {
		return b.hashScore - a.hashScore;
	}

	return a.server.id.localeCompare(b.server.id);
}

function groupAssignments(assignments: string[]): PlacementResult {
	const placements = new Map<string, number>();

	for (const serverId of assignments) {
		placements.set(serverId, (placements.get(serverId) ?? 0) + 1);
	}

	return [...placements].map(([serverId, count]) => ({ serverId, count }));
}
