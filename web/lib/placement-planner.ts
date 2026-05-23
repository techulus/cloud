import { createHash } from "node:crypto";

export type PlacementResult = { serverId: string; count: number }[];

export type PlacementServerSnapshot = {
	id: string;
	status: string;
	wireguardIp: string | null;
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
	count: number;
};

export type PlacementPlanInput = {
	serviceId: string;
	totalReplicas: number;
	servers: PlacementServerSnapshot[];
	existingReplicas: ReplicaAllocationSnapshot[];
	excludeServerIds?: string[];
};

type ProjectedServerLoad = {
	existingReplicas: number;
	assignedServiceReplicas: number;
};

type CandidateScore = {
	server: PlacementServerSnapshot;
	score: number;
	hashScore: number;
};

const EPSILON = 0.000001;
const LIVE_CPU_PRESSURE_WEIGHT = 20;
const LIVE_MEMORY_PRESSURE_WEIGHT = 20;
const LIVE_DISK_PRESSURE_WEIGHT = 15;
const EXISTING_REPLICA_WEIGHT = 2;
const RUNNING_CONTAINER_WEIGHT = 0.5;
const UNRESPONSIVE_RUNTIME_PENALTY = 100;

export function calculateResourceAwarePlacementFromSnapshot({
	serviceId,
	totalReplicas,
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
		// Resource limits are runtime caps, not reserved capacity, so placement
		// ranks eligible servers without treating those limits as guaranteed load.
		const unassignedCandidates = eligibleServers.filter(
			(server) =>
				getProjectedLoad(projectedLoad, server.id).assignedServiceReplicas ===
				0,
		);
		const candidates =
			unassignedCandidates.length > 0 ? unassignedCandidates : eligibleServers;

		const rankedCandidates = candidates
			.map((server) => ({
				server,
				score: scoreServer(server, getProjectedLoad(projectedLoad, server.id)),
				hashScore: rendezvousHashScore(serviceId, replicaIndex, server.id),
			}))
			.sort(compareCandidates);

		const selected = rankedCandidates[0].server;
		assignments.push(selected.id);

		const selectedLoad = getProjectedLoad(projectedLoad, selected.id);
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

function scoreServer(
	server: PlacementServerSnapshot,
	load: ProjectedServerLoad,
) {
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
