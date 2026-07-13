import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { getService } from "@/db/queries";
import {
	deploymentPorts,
	deployments,
	rollouts,
	servers,
	services,
} from "@/db/schema";
import { getCertificate, issueCertificate } from "@/lib/acme-manager";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";
import { findAvailableContainerIp } from "@/lib/wireguard";
import { enqueueWork } from "@/lib/work-queue";

const PORT_RANGE_START = 30000;
const PORT_RANGE_END = 32767;

export type Placement = { serverId: string; replicas: number };

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

export function isActiveDeploymentForRollout(deployment: {
	trafficState: string;
}) {
	return deployment.trafficState === "active";
}

export function normalizeImage(image: string): string {
	if (!image.includes("/")) {
		return `docker.io/library/${image}`;
	}
	if (!image.includes(".") && image.split("/").length === 2) {
		return `docker.io/${image}`;
	}
	return image;
}

export function findAvailableHostPorts(
	usedPorts: Iterable<number>,
	count: number,
): number[] {
	const unavailablePorts = new Set(usedPorts);
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

export async function prepareRollingUpdate(
	serviceId: string,
): Promise<{ deploymentIds: string[] }> {
	const service = await getService(serviceId);
	if (!service) {
		return { deploymentIds: [] };
	}

	const existingDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const runningDeployments = existingDeployments.filter((d) =>
		isActiveDeploymentForRollout(d),
	);

	return { deploymentIds: runningDeployments.map((d) => d.id) };
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

			await db.transaction(async (tx) => {
				await tx.execute(
					sql`SELECT pg_advisory_xact_lock(hashtext(${`deployment-allocation:${server.id}`}))`,
				);

				if (specification.stateful) {
					const lockedService = await tx
						.select({ lockedServerId: services.lockedServerId })
						.from(services)
						.where(eq(services.id, serviceId))
						.for("update")
						.then((rows) => rows[0]);
					if (!lockedService) {
						throw new Error("Service not found");
					}
					if (
						lockedService.lockedServerId &&
						lockedService.lockedServerId !== server.id
					) {
						throw new Error(
							`Stateful service is locked to server ${lockedService.lockedServerId}`,
						);
					}
					if (!lockedService.lockedServerId) {
						await tx
							.update(services)
							.set({ lockedServerId: server.id })
							.where(eq(services.id, serviceId));
					}
				}

				const [usedPortRows, subnet, usedIpRows] = await Promise.all([
					tx
						.select({ hostPort: deploymentPorts.hostPort })
						.from(deploymentPorts)
						.innerJoin(
							deployments,
							eq(deploymentPorts.deploymentId, deployments.id),
						)
						.where(eq(deployments.serverId, server.id)),
					tx
						.select({ subnetId: servers.subnetId })
						.from(servers)
						.where(eq(servers.id, server.id))
						.then((rows) => rows[0]),
					tx
						.select({ ipAddress: deployments.ipAddress })
						.from(deployments)
						.where(
							and(
								eq(deployments.serverId, server.id),
								isNotNull(deployments.ipAddress),
							),
						),
				]);

				if (!subnet?.subnetId) {
					throw new Error(`Server ${server.name} has no subnet assigned`);
				}

				const hostPorts = findAvailableHostPorts(
					usedPortRows.map((port) => port.hostPort),
					specification.ports.length,
				);
				const ipAddress = findAvailableContainerIp(
					subnet.subnetId,
					usedIpRows.flatMap((deployment) =>
						deployment.ipAddress ? [deployment.ipAddress] : [],
					),
				);

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
				revisionId,
			});
		}
	}

	return { deploymentIds };
}

export async function completeRolloutWithRevision(
	rolloutId: string,
	serviceId: string,
	context: Omit<DeploymentContext, "serverMap">,
): Promise<{ completed: boolean; stoppedCount: number }> {
	const {
		placements,
		revisionId,
		specification,
		totalReplicas,
		isRollingUpdate,
	} = context;
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
				activeRevisionId: revisionId,
				replicas: totalReplicas,
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

	const existingDeployments = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));

	const runningDeployments = existingDeployments.filter((d) =>
		isActiveDeploymentForRollout(d),
	);

	return runningDeployments.length > 0;
}
