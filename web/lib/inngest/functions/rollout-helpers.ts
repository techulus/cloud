import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import {
	deploymentPorts,
	deployments,
	rollouts,
	servers,
	services,
} from "@/db/schema";
import { getCertificate, issueCertificate } from "@/lib/acme-manager";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";
import { assignContainerIp } from "@/lib/wireguard";
import { enqueueWork } from "@/lib/work-queue";

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

export function normalizeImage(image: string): string {
	if (!image.includes("/")) {
		return `docker.io/library/${image}`;
	}
	if (!image.includes(".") && image.split("/").length === 2) {
		return `docker.io/${image}`;
	}
	return image;
}

async function getUsedPorts(serverId: string): Promise<Set<number>> {
	const existingPorts = await db
		.select({ hostPort: deploymentPorts.hostPort })
		.from(deploymentPorts)
		.innerJoin(deployments, eq(deploymentPorts.deploymentId, deployments.id))
		.where(eq(deployments.serverId, serverId));

	return new Set(existingPorts.map((port) => port.hostPort));
}

export async function allocateHostPorts(
	serverId: string,
	count: number,
): Promise<number[]> {
	const unavailablePorts = await getUsedPorts(serverId);
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

export async function cleanupExistingDeployments(
	serviceId: string,
): Promise<{ deletedCount: number }> {
	const deletedDeployments = await db
		.delete(deployments)
		.where(eq(deployments.serviceId, serviceId))
		.returning({ id: deployments.id });

	return { deletedCount: deletedDeployments.length };
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
): Promise<{ deploymentIds: string[] }> {
	const { revisionId, specification, placements, serverMap } = context;

	const deploymentIds: string[] = [];

	for (const placement of placements) {
		if (placement.replicas <= 0) continue;

		const server = serverMap.get(placement.serverId);
		if (!server) {
			throw new Error(`Server ${placement.serverId} not found`);
		}

		for (let i = 0; i < placement.replicas; i++) {
			const deploymentId = randomUUID();
			const hostPorts = await allocateHostPorts(
				server.id,
				specification.ports.length,
			);
			const ipAddress = await assignContainerIp(server.id);

			await db.transaction(async (tx) => {
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
							containerPort: port.containerPort,
							hostPort: hostPorts[index],
						})),
					);
				}
			});

			deploymentIds.push(deploymentId);

			await enqueueWork(server.id, "reconcile", {
				reason: "rollout_deployment_created",
				deploymentId,
			});
		}
	}

	return { deploymentIds };
}

export async function completeRollout(
	rolloutId: string,
	serviceId: string,
	context: Omit<DeploymentContext, "serverMap" | "revisionId">,
): Promise<{ completed: boolean; stoppedCount: number }> {
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
			return { completed: false, stoppedCount: 0 };
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
					.returning({ id: deployments.id })
			: [];

		await tx
			.update(services)
			.set({
				...(specification.placement.mode === "automatic"
					? { lastAutomaticPlacementAt: new Date() }
					: {}),
				...(lockedServerId ? { lockedServerId } : {}),
			})
			.where(eq(services.id, serviceId));

		await tx
			.update(rollouts)
			.set({
				status: "completed",
				currentStage: "completed",
				completedAt: new Date(),
			})
			.where(eq(rollouts.id, rolloutId));
		return { completed: true, stoppedCount: stoppedDeployments.length };
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
