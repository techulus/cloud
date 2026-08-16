import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";
import { db } from "@/db";
import {
	builds,
	deploymentPorts,
	deployments,
	githubRepos,
	rollouts,
	secrets,
	servers,
	servicePorts,
	serviceReplicas,
	serviceCrons,
	serviceRevisions,
	services,
	serviceVolumes,
	volumeBackups,
} from "@/db/schema";
import { requireRequestDeveloperRole } from "@/lib/api-auth";
import { auth } from "@/lib/auth";
import { getTimestamp } from "@/lib/date";
import { resolvePersistedSourceFromRows } from "@/lib/public-api";
import {
	revisionSpecToDeployedConfig,
	type SourceConfig,
} from "@/lib/service-config";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";

const MAX_CANVAS_COORDINATE = 2_147_483_647;

class CanvasServiceNotFoundError extends Error {}

const canvasPositionsSchema = z.object({
	positions: z
		.array(
			z.object({
				serviceId: z.string().min(1),
				canvasX: z.number().int().min(0).max(MAX_CANVAS_COORDINATE),
				canvasY: z.number().int().min(0).max(MAX_CANVAS_COORDINATE),
			}),
		)
		.min(1)
		.max(10_000)
		.refine(
			(positions) =>
				new Set(positions.map((position) => position.serviceId)).size ===
				positions.length,
		),
});

export async function PATCH(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const sessionResult = await requireRequestDeveloperRole(request);
	if (!sessionResult.ok) {
		return sessionResult.response;
	}

	const { id: projectId } = await params;
	const body = await request.json().catch(() => null);
	const parsed = canvasPositionsSchema.safeParse(body);

	if (!parsed.success) {
		return Response.json({ error: "Invalid positions" }, { status: 400 });
	}

	try {
		const savedPositions = await db.transaction(async (tx) => {
			const serviceIds = parsed.data.positions.map(
				(position) => position.serviceId,
			);
			const activeServices = await tx
				.select({ id: services.id })
				.from(services)
				.where(
					and(
						eq(services.projectId, projectId),
						inArray(services.id, serviceIds),
						isNull(services.deletedAt),
						isNull(services.previewOfServiceId),
					),
				);

			if (activeServices.length !== parsed.data.positions.length) {
				throw new CanvasServiceNotFoundError();
			}

			const positions: Array<{
				id: string;
				canvasX: number | null;
				canvasY: number | null;
			}> = [];

			for (const position of parsed.data.positions) {
				const [savedPosition] = await tx
					.update(services)
					.set({
						canvasX: position.canvasX,
						canvasY: position.canvasY,
					})
					.where(
						and(
							eq(services.id, position.serviceId),
							eq(services.projectId, projectId),
							isNull(services.deletedAt),
							isNull(services.previewOfServiceId),
						),
					)
					.returning({
						id: services.id,
						canvasX: services.canvasX,
						canvasY: services.canvasY,
					});

				if (!savedPosition) {
					throw new CanvasServiceNotFoundError();
				}

				positions.push(savedPosition);
			}

			return positions;
		});

		return Response.json(savedPositions);
	} catch (error) {
		if (error instanceof CanvasServiceNotFoundError) {
			return Response.json({ error: "Service not found" }, { status: 404 });
		}

		throw error;
	}
}

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
						isNull(services.previewOfServiceId),
					)
				: and(
						eq(services.projectId, projectId),
						isNull(services.deletedAt),
						isNull(services.previewOfServiceId),
					),
		)
		.orderBy(services.createdAt);
	const cronRows =
		servicesList.length > 0
			? await db
					.select()
					.from(serviceCrons)
					.where(
						inArray(
							serviceCrons.serviceId,
							servicesList.map((service) => service.id),
						),
					)
					.orderBy(serviceCrons.path)
			: [];
	const cronsByService = Map.groupBy(cronRows, (cron) => cron.serviceId);

	const result = await Promise.all(
		servicesList.map(async (service) => {
			const [
				ports,
				serviceDeployments,
				replicas,
				serviceSecrets,
				serviceRollouts,
				activeRollout,
				volumes,
				lockedServer,
				latestBuild,
				activeBuild,
				githubRepo,
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
					.from(rollouts)
					.where(
						and(
							eq(rollouts.serviceId, service.id),
							inArray(rollouts.status, ["queued", "in_progress"]),
						),
					)
					.orderBy(desc(rollouts.createdAt))
					.limit(1)
					.then((r) => r[0] || null),
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
				db
					.select({ id: builds.id, status: builds.status })
					.from(builds)
					.where(
						and(
							eq(builds.serviceId, service.id),
							inArray(builds.status, [
								"pending",
								"claimed",
								"cloning",
								"building",
								"pushing",
							]),
						),
					)
					.orderBy(desc(builds.createdAt))
					.limit(1)
					.then((r) => r[0] || null),
				service.sourceType === "github"
					? db
							.select()
							.from(githubRepos)
							.where(eq(githubRepos.serviceId, service.id))
							.then((r) => r[0] || null)
					: Promise.resolve(null),
			]);
			const persistedSource = resolvePersistedSourceFromRows(
				service,
				githubRepo ?? undefined,
			);
			const currentSource: SourceConfig =
				persistedSource.type === "github"
					? {
							type: "github",
							repository: persistedSource.repository,
							branch: persistedSource.branch,
							rootDir: persistedSource.rootDir ?? null,
						}
					: persistedSource;

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
			const activeSpecification = activeRevision
				? parseServiceRevisionSpec(activeRevision.specification)
				: null;
			const revisionServers = activeSpecification
				? await db
						.select({ id: servers.id, name: servers.name })
						.from(servers)
						.where(
							inArray(
								servers.id,
								activeSpecification.placements.map(
									(placement) => placement.serverId,
								),
							),
						)
				: [];
			const activeConfig = activeSpecification
				? revisionSpecToDeployedConfig(
						activeSpecification,
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
							.select({
								name: servers.name,
								wireguardIp: servers.wireguardIp,
								status: servers.status,
							})
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
				crons: cronsByService.get(service.id) ?? [],
				configuredReplicas: replicas,
				deployments: deploymentsWithDetails,
				secrets: serviceSecrets,
				rollouts: serviceRollouts,
				activeRollout,
				volumes,
				lockedServer,
				latestBuild,
				activeBuild,
				hasGithubAppRepo: githubRepo !== null,
				activeConfig,
				currentSource,
				deletionBackupFallback,
			};
		}),
	);

	return Response.json(result);
}
