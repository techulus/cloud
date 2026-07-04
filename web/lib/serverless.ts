import { randomUUID } from "node:crypto";
import {
	and,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
	deployments,
	rollouts,
	serverlessServiceActivity,
	servers,
	servicePorts,
	services,
	workQueue,
} from "@/db/schema";
import { markDeploymentUndesired } from "@/lib/deployment-status";

const READY_DEPLOYMENT_STATUSES = ["healthy", "running"] as const;
const WAKE_IN_PROGRESS_STATUSES = [
	"pending",
	"pulling",
	"starting",
	"waking",
] as const;
const SLEEPABLE_DEPLOYMENT_STATUSES = ["healthy", "running"] as const;
const SERVERLESS_BUSY_DEPLOYMENT_STATUSES = [
	"pending",
	"pulling",
	"starting",
	"waking",
	"draining",
	"stopping",
] as const;

const WAKE_POLL_INTERVAL_MS = 500;
const MIN_ACTIVE_REQUEST_STALE_SECONDS = 120;

export type ServerlessServiceRef = {
	serviceId?: string;
	host?: string;
};

export type ServerlessDeployment = {
	id: string;
	serverId: string;
	ipAddress: string | null;
	status: string;
};

export type ServerlessUpstream = {
	url: string;
};

export type ServerlessWakeResult = {
	status:
		| "ready"
		| "waking"
		| "not_found"
		| "not_serverless"
		| "unsupported"
		| "no_deployments";
	serviceId: string;
	readyDeployments: ServerlessDeployment[];
	upstreams: ServerlessUpstream[];
	wakingDeployments: number;
	queuedWakeServers: number;
	minReadyReplicas: number;
};

export type ServerlessWaitResult = ServerlessWakeResult & {
	timedOut: boolean;
};

export type ServerlessSleepResult = {
	servicesChecked: number;
	servicesSlept: number;
	deploymentsSlept: number;
	wakingDeploymentsFailed: number;
};

type ServerlessService = typeof services.$inferSelect;
type DeploymentRow = typeof deployments.$inferSelect;
type DbExecutor = Pick<typeof db, "execute" | "insert" | "select" | "update">;

type ServerlessTarget = {
	serviceId: string;
	port: number;
};

export async function resolveServerlessServiceId({
	serviceId,
	host,
}: ServerlessServiceRef): Promise<string | null> {
	return (
		(await resolveServerlessTarget({ serviceId, host }))?.serviceId ?? null
	);
}

export async function resolveServerlessTarget({
	serviceId,
	host,
}: ServerlessServiceRef): Promise<ServerlessTarget | null> {
	if (serviceId) {
		const [port] = await db
			.select({ port: servicePorts.port })
			.from(servicePorts)
			.where(
				and(
					eq(servicePorts.serviceId, serviceId),
					eq(servicePorts.protocol, "http"),
					eq(servicePorts.isPublic, true),
					isNotNull(servicePorts.domain),
				),
			)
			.limit(1);
		return port ? { serviceId, port: port.port } : null;
	}

	const normalizedHost = normalizeHost(host);
	if (!normalizedHost) return null;

	const [port] = await db
		.select({ serviceId: servicePorts.serviceId, port: servicePorts.port })
		.from(servicePorts)
		.innerJoin(services, eq(services.id, servicePorts.serviceId))
		.where(
			and(
				eq(servicePorts.domain, normalizedHost),
				eq(servicePorts.protocol, "http"),
				eq(servicePorts.isPublic, true),
				isNull(services.deletedAt),
			),
		)
		.limit(1);

	return port ? { serviceId: port.serviceId, port: port.port } : null;
}

export async function recordServerlessRequestStart({
	serviceId,
	proxyServerId,
	now = new Date(),
}: {
	serviceId: string;
	proxyServerId: string;
	now?: Date;
}) {
	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);
		const service = await getServerlessService(tx, serviceId);
		if (service) {
			await resetStaleActiveRequests(tx, service, now);
		}
		await touchServerlessRequestStart(tx, {
			serviceId,
			proxyServerId,
			now,
		});
	});
}

export async function recordServerlessRequestFinish({
	serviceId,
	proxyServerId,
	now = new Date(),
}: {
	serviceId: string;
	proxyServerId: string;
	now?: Date;
}) {
	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);
		await touchServerlessRequestFinish(tx, {
			serviceId,
			proxyServerId,
			now,
		});
	});
}

export async function recordServerlessRequestHeartbeat({
	serviceId,
	proxyServerId,
	now = new Date(),
}: {
	serviceId: string;
	proxyServerId: string;
	now?: Date;
}) {
	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);
		await touchServerlessRequestHeartbeat(tx, {
			serviceId,
			proxyServerId,
			now,
		});
	});
}

async function touchServerlessRequestStart(
	executor: DbExecutor,
	{
		serviceId,
		proxyServerId,
		now,
	}: {
		serviceId: string;
		proxyServerId: string;
		now: Date;
	},
) {
	await executor
		.insert(serverlessServiceActivity)
		.values({
			id: randomUUID(),
			serviceId,
			proxyServerId,
			lastRequestAt: now,
			activeRequests: 1,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [
				serverlessServiceActivity.serviceId,
				serverlessServiceActivity.proxyServerId,
			],
			set: {
				lastRequestAt: now,
				activeRequests: sql`${serverlessServiceActivity.activeRequests} + 1`,
				updatedAt: now,
			},
		});
}

async function touchServerlessRequestFinish(
	executor: DbExecutor,
	{
		serviceId,
		proxyServerId,
		now,
	}: {
		serviceId: string;
		proxyServerId: string;
		now: Date;
	},
) {
	await executor
		.insert(serverlessServiceActivity)
		.values({
			id: randomUUID(),
			serviceId,
			proxyServerId,
			lastRequestAt: now,
			activeRequests: 0,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [
				serverlessServiceActivity.serviceId,
				serverlessServiceActivity.proxyServerId,
			],
			set: {
				activeRequests: sql`GREATEST(${serverlessServiceActivity.activeRequests} - 1, 0)`,
				lastRequestAt: now,
				updatedAt: now,
			},
		});
}

async function touchServerlessRequestHeartbeat(
	executor: DbExecutor,
	{
		serviceId,
		proxyServerId,
		now,
	}: {
		serviceId: string;
		proxyServerId: string;
		now: Date;
	},
) {
	await executor
		.insert(serverlessServiceActivity)
		.values({
			id: randomUUID(),
			serviceId,
			proxyServerId,
			lastRequestAt: now,
			activeRequests: 0,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [
				serverlessServiceActivity.serviceId,
				serverlessServiceActivity.proxyServerId,
			],
			set: {
				lastRequestAt: now,
				updatedAt: now,
			},
		});
}

export async function wakeServerlessService({
	serviceId,
	port,
	proxyServerId,
	now = new Date(),
}: {
	serviceId: string;
	port?: number;
	proxyServerId: string;
	now?: Date;
}): Promise<ServerlessWakeResult> {
	return db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);

		const [service] = await tx
			.select()
			.from(services)
			.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
			.limit(1);

		if (!service) return emptyWakeResult("not_found", serviceId);
		const unsupported = await getServerlessUnsupportedReason(tx, service);
		if (unsupported) return emptyWakeResult(unsupported, serviceId);

		await touchServerlessActivity(tx, { serviceId, proxyServerId, now });

		const minReadyReplicas = getMinReadyReplicas(service);
		const targetPort = port ?? (await getDefaultHttpPort(tx, serviceId));
		if (!targetPort) return emptyWakeResult("unsupported", serviceId);

		const readyDeployments = await getReadyDeployments(tx, serviceId);
		if (readyDeployments.length >= minReadyReplicas) {
			return {
				status: "ready",
				serviceId,
				readyDeployments,
				upstreams: buildUpstreams(readyDeployments, targetPort),
				wakingDeployments: 0,
				queuedWakeServers: 0,
				minReadyReplicas,
			};
		}

		const wakeableDeployments = await tx
			.select()
			.from(deployments)
			.where(
				and(
					eq(deployments.serviceId, serviceId),
					eq(deployments.desired, true),
					eq(deployments.status, "sleeping"),
				),
			);

		if (readyDeployments.length === 0 && wakeableDeployments.length === 0) {
			const wakingDeployments = await countWakeInProgressDeployments(
				tx,
				serviceId,
			);
			return {
				status: wakingDeployments > 0 ? "waking" : "no_deployments",
				serviceId,
				readyDeployments,
				upstreams: [],
				wakingDeployments,
				queuedWakeServers: 0,
				minReadyReplicas,
			};
		}

		if (wakeableDeployments.length > 0) {
			const wakeableIds = wakeableDeployments.map(
				(deployment) => deployment.id,
			);
			// Wake all desired replicas; minReadyReplicas controls when requests can resume.
			await tx
				.update(deployments)
				.set({
					status: "waking",
					healthStatus: null,
					unhealthyReportCount: 0,
					serverlessWakeStartedAt: now,
				})
				.where(inArray(deployments.id, wakeableIds));
		}

		const queuedWakeServers = await enqueueWakeReconcilers(
			tx,
			serviceId,
			wakeableDeployments,
		);
		const wakingDeployments = await countWakeInProgressDeployments(
			tx,
			serviceId,
		);

		return {
			status: "waking",
			serviceId,
			readyDeployments,
			upstreams: [],
			wakingDeployments,
			queuedWakeServers,
			minReadyReplicas,
		};
	});
}

export async function wakeAndWaitForServerlessService({
	serviceId,
	port,
	proxyServerId,
	timeoutSeconds,
	now = new Date(),
}: {
	serviceId: string;
	port?: number;
	proxyServerId: string;
	timeoutSeconds?: number;
	now?: Date;
}): Promise<ServerlessWaitResult> {
	const wakeResult = await wakeServerlessService({
		serviceId,
		port,
		proxyServerId,
		now,
	});

	if (wakeResult.status !== "waking") {
		return { ...wakeResult, timedOut: false };
	}

	const configuredTimeoutSeconds =
		timeoutSeconds ?? (await getWakeTimeoutSeconds(serviceId)) ?? 300;
	const targetPort = port ?? (await getDefaultHttpPort(db, serviceId));
	const timeoutMs = Math.max(1, configuredTimeoutSeconds) * 1000;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		await sleep(WAKE_POLL_INTERVAL_MS);
		const readyDeployments = await getReadyDeployments(db, serviceId);
		if (targetPort && readyDeployments.length >= wakeResult.minReadyReplicas) {
			return {
				...wakeResult,
				status: "ready",
				readyDeployments,
				upstreams: buildUpstreams(readyDeployments, targetPort),
				timedOut: false,
			};
		}
	}

	return { ...wakeResult, timedOut: true };
}

export async function sleepIdleServerlessServices({
	now = new Date(),
}: {
	now?: Date;
} = {}): Promise<ServerlessSleepResult> {
	const candidates = await db
		.select()
		.from(services)
		.where(
			and(
				eq(services.serverlessEnabled, true),
				eq(services.stateful, false),
				isNull(services.deletedAt),
			),
		);

	let servicesSlept = 0;
	let deploymentsSlept = 0;
	let wakingDeploymentsFailed = 0;

	for (const service of candidates) {
		wakingDeploymentsFailed += await failTimedOutWakingDeployments({
			service,
			now,
		});
		if (!(await hasPublicHttpEndpoint(db, service.id))) continue;
		if (!(await isServiceIdle(db, service, now))) continue;

		const result = await sleepServerlessService({
			serviceId: service.id,
			now,
		});
		if (result.deploymentsSlept > 0) {
			servicesSlept += 1;
			deploymentsSlept += result.deploymentsSlept;
		}
	}

	return {
		servicesChecked: candidates.length,
		servicesSlept,
		deploymentsSlept,
		wakingDeploymentsFailed,
	};
}

export async function sleepServerlessService({
	serviceId,
	now = new Date(),
}: {
	serviceId: string;
	now?: Date;
}): Promise<{ deploymentsSlept: number }> {
	return db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${serviceId}))`);

		const [service] = await tx
			.select()
			.from(services)
			.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
			.limit(1);

		if (!service) return { deploymentsSlept: 0 };
		const unsupported = await getServerlessUnsupportedReason(tx, service);
		if (unsupported) return { deploymentsSlept: 0 };
		if (!(await isServiceIdle(tx, service, now))) {
			return { deploymentsSlept: 0 };
		}

		const sleepableDeployments = await tx
			.select()
			.from(deployments)
			.where(
				and(
					eq(deployments.serviceId, serviceId),
					eq(deployments.desired, true),
					inArray(deployments.status, SLEEPABLE_DEPLOYMENT_STATUSES),
					isNotNull(deployments.containerId),
				),
			);

		if (sleepableDeployments.length === 0) return { deploymentsSlept: 0 };

		await tx
			.update(deployments)
			.set({
				status: "sleeping",
				healthStatus: null,
				serverlessWakeStartedAt: null,
			})
			.where(
				inArray(
					deployments.id,
					sleepableDeployments.map((deployment) => deployment.id),
				),
			);

		for (const deployment of sleepableDeployments) {
			await tx.insert(workQueue).values({
				id: randomUUID(),
				serverId: deployment.serverId,
				type: "sleep",
				payload: JSON.stringify({
					reason: "serverless_idle_timeout",
					deploymentId: deployment.id,
					serviceId,
					containerId: deployment.containerId,
				}),
			});
		}

		return { deploymentsSlept: sleepableDeployments.length };
	});
}

async function getServerlessUnsupportedReason(
	executor: DbExecutor,
	service: ServerlessService,
): Promise<"not_serverless" | "unsupported" | null> {
	if (!service.serverlessEnabled) return "not_serverless";
	if (service.stateful) return "unsupported";
	if (!(await hasPublicHttpEndpoint(executor, service.id)))
		return "unsupported";
	return null;
}

async function hasPublicHttpEndpoint(executor: DbExecutor, serviceId: string) {
	const [port] = await executor
		.select({ id: servicePorts.id })
		.from(servicePorts)
		.where(
			and(
				eq(servicePorts.serviceId, serviceId),
				eq(servicePorts.protocol, "http"),
				eq(servicePorts.isPublic, true),
				isNotNull(servicePorts.domain),
			),
		)
		.limit(1);

	return Boolean(port);
}

export async function isProxyServer(serverId: string) {
	const [server] = await db
		.select({ isProxy: servers.isProxy })
		.from(servers)
		.where(eq(servers.id, serverId))
		.limit(1);
	return server?.isProxy === true;
}

async function isServiceIdle(
	executor: DbExecutor,
	service: ServerlessService,
	now: Date,
) {
	const [activeRollout] = await executor
		.select({ id: rollouts.id })
		.from(rollouts)
		.where(
			and(
				eq(rollouts.serviceId, service.id),
				inArray(rollouts.status, ["queued", "in_progress"]),
			),
		)
		.limit(1);
	if (activeRollout) return false;

	const [busyDeployment] = await executor
		.select({ id: deployments.id })
		.from(deployments)
		.where(
			and(
				eq(deployments.serviceId, service.id),
				inArray(deployments.status, SERVERLESS_BUSY_DEPLOYMENT_STATUSES),
			),
		)
		.limit(1);
	if (busyDeployment) return false;

	await resetStaleActiveRequests(executor, service, now);

	const activityRows = await executor
		.select({
			lastRequestAt: serverlessServiceActivity.lastRequestAt,
			activeRequests: serverlessServiceActivity.activeRequests,
			updatedAt: serverlessServiceActivity.updatedAt,
		})
		.from(serverlessServiceActivity)
		.where(eq(serverlessServiceActivity.serviceId, service.id));

	const activeRequestStaleCutoff = getActiveRequestStaleCutoff(service, now);
	const activeRequests = activityRows.reduce((total, row) => {
		if (row.activeRequests <= 0) return total;
		if (row.updatedAt <= activeRequestStaleCutoff) return total;
		return total + row.activeRequests;
	}, 0);
	if (activeRequests > 0) return false;

	const lastRequestAt = maxDate(
		activityRows
			.map((row) => row.lastRequestAt)
			.filter((value): value is Date => value !== null),
	);
	const sleepableDeployments = await executor
		.select({ createdAt: deployments.createdAt })
		.from(deployments)
		.where(
			and(
				eq(deployments.serviceId, service.id),
				eq(deployments.desired, true),
				inArray(deployments.status, SLEEPABLE_DEPLOYMENT_STATUSES),
			),
		);

	if (sleepableDeployments.length === 0) return false;

	const newestDeploymentCreatedAt = maxDate(
		sleepableDeployments.map((deployment) => deployment.createdAt),
	);
	const lastActivityAt = maxDate(
		[lastRequestAt, newestDeploymentCreatedAt].filter(
			(value): value is Date => value !== null,
		),
	);
	if (!lastActivityAt) return false;

	const idleMs = now.getTime() - lastActivityAt.getTime();
	return idleMs >= service.serverlessSleepAfterSeconds * 1000;
}

async function failTimedOutWakingDeployments({
	service,
	now,
}: {
	service: ServerlessService;
	now: Date;
}) {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext(${service.id}))`,
		);

		const timeoutCutoff = new Date(
			now.getTime() - getWakeTimeoutSecondsForService(service) * 1000,
		);
		const timedOut = await tx
			.update(deployments)
			.set({
				...markDeploymentUndesired("failed"),
				failedStage: "serverless_wake_timeout",
				healthStatus: null,
				serverlessWakeStartedAt: null,
			})
			.where(
				and(
					eq(deployments.serviceId, service.id),
					eq(deployments.status, "waking"),
					eq(deployments.desired, true),
					or(
						lte(deployments.serverlessWakeStartedAt, timeoutCutoff),
						and(
							isNull(deployments.serverlessWakeStartedAt),
							lte(deployments.createdAt, timeoutCutoff),
						),
					),
				),
			)
			.returning({ id: deployments.id });

		return timedOut.length;
	});
}

async function touchServerlessActivity(
	executor: DbExecutor,
	{
		serviceId,
		proxyServerId,
		now,
	}: {
		serviceId: string;
		proxyServerId: string;
		now: Date;
	},
) {
	await executor
		.insert(serverlessServiceActivity)
		.values({
			id: randomUUID(),
			serviceId,
			proxyServerId,
			lastRequestAt: now,
			activeRequests: 0,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [
				serverlessServiceActivity.serviceId,
				serverlessServiceActivity.proxyServerId,
			],
			set: {
				lastRequestAt: now,
				updatedAt: now,
			},
		});
}

async function getServerlessService(
	executor: DbExecutor,
	serviceId: string,
): Promise<ServerlessService | null> {
	const [service] = await executor
		.select()
		.from(services)
		.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
		.limit(1);
	return service ?? null;
}

async function getWakeTimeoutSeconds(serviceId: string) {
	const [service] = await db
		.select({ wakeTimeoutSeconds: services.serverlessWakeTimeoutSeconds })
		.from(services)
		.where(eq(services.id, serviceId))
		.limit(1);
	return service?.wakeTimeoutSeconds ?? null;
}

async function getDefaultHttpPort(executor: DbExecutor, serviceId: string) {
	const [port] = await executor
		.select({ port: servicePorts.port })
		.from(servicePorts)
		.where(
			and(
				eq(servicePorts.serviceId, serviceId),
				eq(servicePorts.protocol, "http"),
				eq(servicePorts.isPublic, true),
				isNotNull(servicePorts.domain),
			),
		)
		.limit(1);
	return port?.port ?? null;
}

async function getReadyDeployments(
	executor: DbExecutor,
	serviceId: string,
): Promise<ServerlessDeployment[]> {
	return executor
		.select({
			id: deployments.id,
			serverId: deployments.serverId,
			ipAddress: deployments.ipAddress,
			status: deployments.status,
		})
		.from(deployments)
		.where(
			and(
				eq(deployments.serviceId, serviceId),
				eq(deployments.desired, true),
				inArray(deployments.status, READY_DEPLOYMENT_STATUSES),
				isNotNull(deployments.ipAddress),
			),
		);
}

async function countWakeInProgressDeployments(
	executor: DbExecutor,
	serviceId: string,
) {
	const rows = await executor
		.select({ id: deployments.id })
		.from(deployments)
		.where(
			and(
				eq(deployments.serviceId, serviceId),
				eq(deployments.desired, true),
				inArray(deployments.status, WAKE_IN_PROGRESS_STATUSES),
			),
		);
	return rows.length;
}

async function resetStaleActiveRequests(
	executor: DbExecutor,
	service: ServerlessService,
	now: Date,
) {
	const staleCutoff = getActiveRequestStaleCutoff(service, now);
	await executor
		.update(serverlessServiceActivity)
		.set({ activeRequests: 0, updatedAt: now })
		.where(
			and(
				eq(serverlessServiceActivity.serviceId, service.id),
				gt(serverlessServiceActivity.activeRequests, 0),
				lte(serverlessServiceActivity.updatedAt, staleCutoff),
			),
		);
}

function buildUpstreams(
	deployments: ServerlessDeployment[],
	port: number,
): ServerlessUpstream[] {
	return deployments
		.filter((deployment) => deployment.ipAddress)
		.map((deployment) => ({ url: `${deployment.ipAddress}:${port}` }))
		.sort((a, b) => a.url.localeCompare(b.url));
}

async function enqueueWakeReconcilers(
	executor: DbExecutor,
	serviceId: string,
	wakeableDeployments: DeploymentRow[],
) {
	const serverIds = new Set(
		wakeableDeployments.map((deployment) => deployment.serverId),
	);

	for (const serverId of serverIds) {
		await executor.insert(workQueue).values({
			id: randomUUID(),
			serverId,
			type: "wake",
			payload: JSON.stringify({
				reason: "serverless_wake",
				serviceId,
			}),
		});
	}

	return serverIds.size;
}

function emptyWakeResult(
	status: ServerlessWakeResult["status"],
	serviceId: string,
): ServerlessWakeResult {
	return {
		status,
		serviceId,
		readyDeployments: [],
		upstreams: [],
		wakingDeployments: 0,
		queuedWakeServers: 0,
		minReadyReplicas: 1,
	};
}

function getMinReadyReplicas(service: ServerlessService) {
	return Math.max(1, service.serverlessMinReadyReplicas ?? 1);
}

function getWakeTimeoutSecondsForService(service: ServerlessService) {
	return Math.max(1, service.serverlessWakeTimeoutSeconds ?? 300);
}

function getActiveRequestStaleCutoff(service: ServerlessService, now: Date) {
	const staleSeconds = Math.max(
		MIN_ACTIVE_REQUEST_STALE_SECONDS,
		getWakeTimeoutSecondsForService(service),
	);
	return new Date(now.getTime() - staleSeconds * 1000);
}

function normalizeHost(host: string | undefined) {
	return host?.trim().toLowerCase().replace(/:\d+$/, "") || null;
}

function maxDate(values: Date[]) {
	if (values.length === 0) return null;
	return values.reduce((max, value) => (value > max ? value : max), values[0]);
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
