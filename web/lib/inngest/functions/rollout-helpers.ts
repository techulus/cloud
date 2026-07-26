import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	rollouts,
	servers,
	services,
	workQueue,
} from "@/db/schema";
import { getCertificate, issueCertificate } from "@/lib/acme-manager";
import {
	bumpAgentGeneration,
	type DbTransaction,
} from "@/lib/agent-generation";
import { CONTAINER_SUBNET_PREFIX } from "@/lib/constants";
import { recordRolloutStageBoundary } from "@/lib/rollout-timeline";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";
import { buildRolloutReconcileWorkItem } from "@/lib/work-queue";

const PORT_RANGE_START = 30000;
const PORT_RANGE_END = 32767;

export type Placement = { serverId: string; replicas: number };

export function automaticPlacementIneligibilityReason(
	server: {
		status: string;
		wireguardIp: string | null;
		isProxy: boolean;
	},
	requireProxy = false,
): string | null {
	if (server.status !== "online") return `status is ${server.status}`;
	if (!server.wireguardIp) return "WireGuard is not configured";
	if (requireProxy && !server.isProxy) return "not a proxy node";
	return null;
}

export function distributeReplicas(
	serverIds: string[],
	replicas: number,
): Placement[] {
	const ids = [...new Set(serverIds)].sort((a, b) => a.localeCompare(b));
	if (ids.length === 0) throw new Error("No eligible servers for deployment");
	if (!Number.isInteger(replicas) || replicas < 1 || replicas > 10)
		throw new Error("Replica count must be between 1 and 10");
	const counts = new Map(ids.map((id) => [id, 0]));
	for (let index = 0; index < replicas; index++) {
		const id = ids[index % ids.length];
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return ids
		.map((serverId) => ({ serverId, replicas: counts.get(serverId) ?? 0 }))
		.filter((placement) => placement.replicas > 0);
}

export type DeploymentContext = {
	revisionId: string;
	specification: ServiceRevisionSpec;
	placements: Placement[];
	serverMap: Map<
		string,
		{ id: string; name: string; wireguardIp: string | null; status: string }
	>;
	totalReplicas: number;
	isRollingUpdate: boolean;
};

export type PlannedDeployment = {
	id: string;
	serverId: string;
};

async function getUsedPorts(
	tx: DbTransaction,
	serverId: string,
): Promise<Set<number>> {
	const existingPorts = await tx
		.select({ hostPort: deploymentPorts.hostPort })
		.from(deploymentPorts)
		.where(eq(deploymentPorts.serverId, serverId));

	return new Set(existingPorts.map((port) => port.hostPort));
}

export async function allocateHostPorts(
	tx: DbTransaction,
	serverId: string,
	count: number,
): Promise<number[]> {
	const unavailablePorts = await getUsedPorts(tx, serverId);
	const allocated: number[] = [];

	for (
		let port = PORT_RANGE_START;
		port <= PORT_RANGE_END && allocated.length < count;
		port++
	) {
		if (!unavailablePorts.has(port)) {
			allocated.push(port);
		}
	}

	if (allocated.length < count) {
		throw new Error("Not enough available ports on this server");
	}

	return allocated;
}

async function allocateContainerIp(tx: DbTransaction, serverId: string) {
	const server = await tx
		.select({ subnetId: servers.subnetId })
		.from(servers)
		.where(eq(servers.id, serverId))
		.then((rows) => rows[0]);
	if (!server?.subnetId)
		throw new Error("Server does not have a subnet assigned");
	const rows = await tx
		.select({ ipAddress: deployments.ipAddress })
		.from(deployments)
		.where(
			and(eq(deployments.serverId, serverId), isNotNull(deployments.ipAddress)),
		);
	const used = new Set(rows.map((row) => row.ipAddress));
	for (let host = 2; host <= 254; host++) {
		const address = `${CONTAINER_SUBNET_PREFIX}.${server.subnetId}.${host}`;
		if (!used.has(address)) return address;
	}
	throw new Error("No available IPs in server subnet");
}

export function calculateRevisionPlacements(
	specification: ServiceRevisionSpec,
): {
	placements: Placement[];
	totalReplicas: number;
} {
	const placements = specification.placements.map((placement) => ({
		serverId: placement.serverId,
		replicas: placement.count,
	}));

	const totalReplicas = placements.reduce((sum, p) => sum + p.replicas, 0);
	if (totalReplicas < 1) {
		throw new Error("At least one replica is required");
	}
	if (totalReplicas > 10) {
		throw new Error("Maximum 10 replicas allowed");
	}

	if (specification.stateful) {
		if (totalReplicas !== 1) {
			throw new Error("Stateful services can only have exactly 1 replica");
		}

		const serverIds = placements.map((p) => p.serverId);
		if (serverIds.length !== 1) {
			throw new Error(
				"Stateful services must be deployed to exactly one server",
			);
		}
	}

	return { placements, totalReplicas };
}

export async function resolveRevisionPlacements(
	specification: ServiceRevisionSpec,
): Promise<{ placements: Placement[]; totalReplicas: number }> {
	if (specification.placement.mode === "manual") {
		const result = calculateRevisionPlacements(specification);
		if (specification.serverless.enabled) {
			const selected = await db
				.select({ id: servers.id, isProxy: servers.isProxy })
				.from(servers)
				.where(
					inArray(
						servers.id,
						result.placements.map((p) => p.serverId),
					),
				);
			if (
				selected.length !== result.placements.length ||
				selected.some((server) => !server.isProxy)
			)
				throw new Error(
					"Serverless services can only be placed on proxy servers",
				);
		}
		return result;
	}
	const eligible = await db
		.select({ id: servers.id })
		.from(servers)
		.where(
			and(
				eq(servers.status, "online"),
				isNotNull(servers.wireguardIp),
				...(specification.serverless.enabled
					? [eq(servers.isProxy, true)]
					: []),
			),
		);
	if (eligible.length === 0) {
		const candidates = await db
			.select({
				name: servers.name,
				status: servers.status,
				wireguardIp: servers.wireguardIp,
				isProxy: servers.isProxy,
			})
			.from(servers);
		const details = candidates.length
			? candidates.map((server) => {
					const reason = automaticPlacementIneligibilityReason(
						server,
						specification.serverless.enabled,
					);
					return `${server.name}: ${reason ?? "eligible state changed during placement"}`;
				})
			: ["no servers configured"];
		const message = `No eligible servers for deployment (${details.join("; ")})`;
		console.warn(`[placement] ${message}`);
		throw new Error(message);
	}
	return {
		placements: distributeReplicas(
			eligible.map((server) => server.id),
			specification.placement.replicas,
		),
		totalReplicas: specification.placement.replicas,
	};
}

export async function validateServers(
	placements: Placement[],
): Promise<
	Map<
		string,
		{ id: string; name: string; wireguardIp: string | null; status: string }
	>
> {
	const serverIds = placements.map((p) => p.serverId);
	if (serverIds.length === 0) {
		throw new Error("No servers selected for deployment");
	}

	const selectedServers = await db
		.select()
		.from(servers)
		.where(inArray(servers.id, serverIds));

	const serverMap = new Map(selectedServers.map((s) => [s.id, s]));

	for (const placement of placements) {
		if (placement.replicas > 0) {
			const server = serverMap.get(placement.serverId);
			if (!server) {
				throw new Error(`Server ${placement.serverId} not found`);
			}
			if (server.status !== "online") {
				throw new Error(`Server ${server.name} is not online`);
			}
			if (!server.wireguardIp) {
				throw new Error(`Server ${server.name} has no WireGuard IP`);
			}
		}
	}

	return serverMap;
}

export async function cleanupTerminalDeployments(
	serviceId: string,
): Promise<void> {
	await db
		.delete(deployments)
		.where(
			and(
				eq(deployments.serviceId, serviceId),
				eq(deployments.runtimeDesiredState, "removed"),
			),
		);
}

export type CertificateProvisioningResult = {
	domains: string[];
	existingDomains: string[];
	issuedDomains: string[];
	failedDomains: string[];
};

export async function issueCertificatesForRevision(
	specification: ServiceRevisionSpec,
): Promise<CertificateProvisioningResult> {
	const domainsNeedingCerts = Array.from(
		new Set(
			specification.ports
				.filter((p) => p.isPublic && p.domain)
				.map((p) => (p.domain as string).trim())
				.filter(Boolean),
		),
	);

	const existingDomains: string[] = [];
	const issuedDomains: string[] = [];
	const failedDomains: string[] = [];

	for (const domain of domainsNeedingCerts) {
		const existingCert = await getCertificate(domain);
		if (existingCert) {
			existingDomains.push(domain);
			continue;
		}

		try {
			await issueCertificate(domain);
			console.log(`[deploy] issued certificate for ${domain}`);
			issuedDomains.push(domain);
		} catch (error) {
			console.error(
				`[deploy] failed to issue certificate for ${domain}:`,
				error,
			);
			failedDomains.push(domain);
		}
	}

	if (failedDomains.length > 0) {
		throw new Error(
			`Certificate provisioning failed for: ${failedDomains.join(", ")}`,
		);
	}

	return {
		domains: domainsNeedingCerts,
		existingDomains,
		issuedDomains,
		failedDomains,
	};
}

export async function createDeploymentRecords(
	rolloutId: string,
	serviceId: string,
	context: DeploymentContext,
	deploymentPlan: PlannedDeployment[],
): Promise<{ deploymentIds: string[] }> {
	const { revisionId, specification, serverMap } = context;

	const deploymentIds = new Set<string>();
	const plansByServer = Map.groupBy(deploymentPlan, (plan) => plan.serverId);
	const serverIds = [...plansByServer.keys()].sort();

	await db.transaction(async (tx) => {
		const changedServerIds = new Set<string>();
		for (const serverId of serverIds) {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${serverId}))`,
			);
		}

		if (!context.isRollingUpdate) {
			const deleted = await tx
				.delete(deployments)
				.where(
					and(
						eq(deployments.serviceId, serviceId),
						or(
							isNull(deployments.rolloutId),
							ne(deployments.rolloutId, rolloutId),
						),
					),
				)
				.returning({ serverId: deployments.serverId });
			for (const deployment of deleted)
				changedServerIds.add(deployment.serverId);
		}

		for (const serverId of serverIds) {
			const server = serverMap.get(serverId);
			if (!server) {
				throw new Error(`Server ${serverId} not found`);
			}
			const serverPlans = plansByServer.get(serverId) ?? [];
			for (const plannedDeployment of serverPlans) {
				const deploymentId = plannedDeployment.id;
				const existingDeployment = await tx
					.select({
						id: deployments.id,
						serviceId: deployments.serviceId,
						rolloutId: deployments.rolloutId,
						serverId: deployments.serverId,
					})
					.from(deployments)
					.where(eq(deployments.id, deploymentId))
					.then((rows) => rows[0]);
				if (existingDeployment) {
					if (
						existingDeployment.serviceId !== serviceId ||
						existingDeployment.rolloutId !== rolloutId ||
						existingDeployment.serverId !== server.id
					) {
						throw new Error(`Deployment plan conflict for ${deploymentId}`);
					}
					deploymentIds.add(deploymentId);
					continue;
				}

				const hostPorts = await allocateHostPorts(
					tx,
					server.id,
					specification.ports.length,
				);
				const ipAddress = await allocateContainerIp(tx, server.id);

				await tx.insert(deployments).values({
					id: deploymentId,
					serviceId,
					serviceRevisionId: revisionId,
					serverId: server.id,
					ipAddress,
					runtimeDesiredState: "running",
					trafficState: "candidate",
					observedPhase: "pending",
					rolloutId,
				});

				if (specification.ports.length > 0) {
					await tx.insert(deploymentPorts).values(
						specification.ports.map((port, index) => ({
							id: randomUUID(),
							deploymentId,
							serverId: server.id,
							containerPort: port.containerPort,
							hostPort: hostPorts[index],
						})),
					);
				}
				deploymentIds.add(deploymentId);
				changedServerIds.add(serverId);
			}
		}
		for (const serverId of changedServerIds) {
			await bumpAgentGeneration(tx, serverId);
		}

		await recordRolloutStageBoundary(tx, {
			rolloutId,
			stage: "deployments_committed",
		});
	});

	return {
		deploymentIds: deploymentPlan
			.map((deployment) => deployment.id)
			.filter((id) => deploymentIds.has(id)),
	};
}

export async function completeRollout(
	rolloutId: string,
	serviceId: string,
	context: Omit<DeploymentContext, "serverMap" | "revisionId">,
): Promise<{
	completed: boolean;
	stoppedCount: number;
	affectedServerIds: string[];
}> {
	const { placements, specification, isRollingUpdate } = context;
	const lockedServerId = specification.stateful
		? placements[0]?.serverId
		: undefined;

	return db.transaction(async (tx) => {
		const rollout = await tx
			.select({ status: rollouts.status })
			.from(rollouts)
			.where(eq(rollouts.id, rolloutId))
			.for("update")
			.then((rows) => rows[0]);
		if (rollout?.status !== "in_progress") {
			return { completed: false, stoppedCount: 0, affectedServerIds: [] };
		}

		const stoppedDeployments = isRollingUpdate
			? await tx
					.update(deployments)
					.set({
						runtimeDesiredState: "removed",
						trafficState: "inactive",
					})
					.where(
						and(
							eq(deployments.serviceId, serviceId),
							eq(deployments.trafficState, "draining"),
						),
					)
					.returning({
						id: deployments.id,
						serverId: deployments.serverId,
					})
			: [];

		const affectedServerIds = [
			...new Set(stoppedDeployments.map((deployment) => deployment.serverId)),
		];
		if (affectedServerIds.length > 0) {
			for (const serverId of affectedServerIds) {
				await bumpAgentGeneration(tx, serverId);
			}
			await tx
				.insert(workQueue)
				.values(
					affectedServerIds.map((serverId) =>
						buildRolloutReconcileWorkItem({
							rolloutId,
							stage: "cleanup",
							serverId,
						}),
					),
				)
				.onConflictDoNothing({ target: workQueue.id });
		}

		const serviceUpdate =
			specification.placement.mode === "automatic"
				? { lastAutomaticPlacementAt: new Date() }
				: lockedServerId
					? { lockedServerId }
					: null;
		if (serviceUpdate) {
			await tx
				.update(services)
				.set(serviceUpdate)
				.where(eq(services.id, serviceId));
		}

		await tx
			.update(rollouts)
			.set({
				status: "completed",
				currentStage: "completed",
				completedAt: new Date(),
			})
			.where(eq(rollouts.id, rolloutId));
		await recordRolloutStageBoundary(tx, {
			rolloutId,
			stage: "completed",
		});
		return {
			completed: true,
			stoppedCount: stoppedDeployments.length,
			affectedServerIds,
		};
	});
}

export async function checkForRollingUpdate(
	serviceId: string,
	specification: ServiceRevisionSpec,
): Promise<boolean> {
	if (specification.stateful) {
		return false;
	}

	const existingDeployment = await db
		.select({ id: deployments.id })
		.from(deployments)
		.where(
			and(
				eq(deployments.serviceId, serviceId),
				eq(deployments.trafficState, "active"),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);

	return existingDeployment != null;
}
