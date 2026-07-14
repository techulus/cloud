export const dynamic = "force-dynamic";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/db";
import {
	builds,
	deploymentPorts,
	deployments,
	rollouts,
	secrets,
	servers,
	servicePorts,
	serviceReplicas,
	serviceRevisions,
	services,
	serviceVolumes,
	volumeBackups,
} from "@/db/schema";
import { auth } from "@/lib/auth";
import { getTimestamp } from "@/lib/date";
import { revisionSpecToDeployedConfig } from "@/lib/service-config";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { id: projectId } = await params;
	const { searchParams } = new URL(request.url);
	const environmentId = searchParams.get("environmentId");

	const servicesList = await db
		.select()
		.from(services)
		.where(
			environmentId
				? and(
						eq(services.projectId, projectId),
						eq(services.environmentId, environmentId),
						isNull(services.deletedAt),
					)
				: and(eq(services.projectId, projectId), isNull(services.deletedAt)),
		)
		.orderBy(services.createdAt);

	const result = await Promise.all(
		servicesList.map(async (service) => {
			const [
				ports,
				serviceDeployments,
				replicas,
				serviceSecrets,
				serviceRollouts,
				volumes,
				lockedServer,
				latestBuild,
			] = await Promise.all([
				db
					.select()
					.from(servicePorts)
					.where(eq(servicePorts.serviceId, service.id))
					.orderBy(servicePorts.port),
				db
					.select()
					.from(deployments)
					.where(eq(deployments.serviceId, service.id))
					.orderBy(deployments.createdAt),
				db
					.select({
						id: serviceReplicas.id,
						serverId: serviceReplicas.serverId,
						serverName: servers.name,
						serverIsProxy: servers.isProxy,
						count: serviceReplicas.count,
					})
					.from(serviceReplicas)
					.innerJoin(servers, eq(serviceReplicas.serverId, servers.id))
					.where(eq(serviceReplicas.serviceId, service.id)),
				db
					.select({ key: secrets.key, updatedAt: secrets.updatedAt })
					.from(secrets)
					.where(eq(secrets.serviceId, service.id)),
				db
					.select()
					.from(rollouts)
					.where(eq(rollouts.serviceId, service.id))
					.orderBy(desc(rollouts.createdAt))
					.limit(1),
				db
					.select()
					.from(serviceVolumes)
					.where(eq(serviceVolumes.serviceId, service.id)),
				service.lockedServerId
					? db
							.select({ name: servers.name })
							.from(servers)
							.where(eq(servers.id, service.lockedServerId))
							.then((r) => r[0])
					: Promise.resolve(null),
				service.sourceType === "github"
					? db
							.select({ id: builds.id, status: builds.status })
							.from(builds)
							.where(eq(builds.serviceId, service.id))
							.orderBy(desc(builds.createdAt))
							.limit(1)
							.then((r) => r[0] || null)
					: Promise.resolve(null),
			]);

			const activeDeployment = serviceDeployments.find(
				(deployment) =>
					deployment.trafficState === "active" &&
					deployment.runtimeDesiredState !== "removed",
			);
			const activeRevision = activeDeployment
				? await db
						.select({ specification: serviceRevisions.specification })
						.from(serviceRevisions)
						.where(eq(serviceRevisions.id, activeDeployment.serviceRevisionId))
						.then((rows) => rows[0])
				: null;
			const revisionServers = activeRevision
				? await db
						.select({ id: servers.id, name: servers.name })
						.from(servers)
						.where(
							inArray(
								servers.id,
								activeRevision.specification.placements.map(
									(placement) => placement.serverId,
								),
							),
						)
				: [];
			const activeConfig = activeRevision
				? revisionSpecToDeployedConfig(
						activeRevision.specification,
						Object.fromEntries(
							revisionServers.map((server) => [server.id, server.name]),
						),
					)
				: null;

			const deploymentsWithDetails = await Promise.all(
				serviceDeployments.map(async (deployment) => {
					const [depPorts, server] = await Promise.all([
						db
							.select({
								id: deploymentPorts.id,
								hostPort: deploymentPorts.hostPort,
								containerPort: deploymentPorts.containerPort,
							})
							.from(deploymentPorts)
							.where(eq(deploymentPorts.deploymentId, deployment.id)),
						db
							.select({ name: servers.name, wireguardIp: servers.wireguardIp })
							.from(servers)
							.where(eq(servers.id, deployment.serverId))
							.then((r) => r[0]),
					]);

					return {
						...deployment,
						ports: depPorts,
						server,
					};
				}),
			);

			let deletionBackupFallback = null;
			if (service.stateful && volumes.length > 0) {
				const completedBackups = await db
					.select({
						volumeId: volumeBackups.volumeId,
						createdAt: volumeBackups.createdAt,
						completedAt: volumeBackups.completedAt,
					})
					.from(volumeBackups)
					.where(
						and(
							eq(volumeBackups.serviceId, service.id),
							eq(volumeBackups.status, "completed"),
						),
					)
					.orderBy(desc(volumeBackups.createdAt));

				const latestByVolume: Record<string, Date | string> = {};
				for (const backup of completedBackups) {
					if (!latestByVolume[backup.volumeId]) {
						latestByVolume[backup.volumeId] =
							backup.completedAt ?? backup.createdAt;
					}
				}

				const latestBackupTimes = volumes
					.map((volume) => latestByVolume[volume.id] ?? null)
					.filter((value): value is Date | string => value !== null);

				deletionBackupFallback = {
					volumeCount: volumes.length,
					backedUpVolumeCount: latestBackupTimes.length,
					oldestLatestBackupAt:
						latestBackupTimes.length > 0
							? latestBackupTimes.reduce((oldest, value) =>
									getTimestamp(value, 0) < getTimestamp(oldest, 0)
										? value
										: oldest,
								)
							: null,
					newestLatestBackupAt:
						latestBackupTimes.length > 0
							? latestBackupTimes.reduce((newest, value) =>
									getTimestamp(value, 0) > getTimestamp(newest, 0)
										? value
										: newest,
								)
							: null,
				};
			}

			return {
				...service,
				ports,
				configuredReplicas: replicas,
				deployments: deploymentsWithDetails,
				secrets: serviceSecrets,
				rollouts: serviceRollouts,
				volumes,
				lockedServer,
				latestBuild,
				activeConfig,
				deletionBackupFallback,
			};
		}),
	);

	return Response.json(result);
}
