import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { builds, deployments, rollouts, servers } from "@/db/schema";
import { requireApiKeyDeveloperRole, requireApiKeyRole } from "@/lib/api-auth";
import { deployServiceInternal } from "@/lib/deploy-service";
import {
	DEFAULT_LOG_TIME_RANGE,
	isLogCursor,
	LOG_TIME_RANGES,
	normalizeLogSearch,
	parseLogLimit,
} from "@/lib/log-query";
import { METRIC_RANGE_KEYS } from "@/lib/metric-ranges";
import {
	apiError,
	badRequest,
	configurationPatchSchema,
	findNestedService,
	isPublicApiDomainError,
	notFound,
	patchConfiguration,
	publicApiDomainResponse,
	resolvePersistedSource,
	safeConfiguration,
} from "@/lib/public-api";
import {
	decodeTimestampCursor,
	nextTimestampCursor,
	type TimestampCursor,
	timestampPage,
} from "@/lib/public-api-pagination";
import { queryServiceRevisionChangelog } from "@/lib/service-revision-changelog";
import {
	isLoggingEnabled,
	isPublicServiceLogEventId,
	type PublicServiceLogCursor,
	queryLogsByRollout,
	queryPublicServiceLogs,
	ServiceLogCursorUnavailableError,
	type StoredLog,
} from "@/lib/victoria-logs";
import { isMetricsEnabled, queryServiceMetrics } from "@/lib/victoria-metrics";

export type PublicServiceParams = {
	projectId: string;
	environmentId: string;
	serviceId: string;
};
export type PublicServiceContext = { params: Promise<PublicServiceParams> };
const readRoles = ["admin", "developer", "reader"] as const;

async function readScope(request: Request, context: PublicServiceContext) {
	const auth = await requireApiKeyRole(request, [...readRoles]);
	if (!auth.ok) return { response: auth.response };
	try {
		const params = await context.params;
		const service = await findNestedService(
			params.projectId,
			params.environmentId,
			params.serviceId,
		);
		return service ? { service, params } : { response: notFound() };
	} catch (error) {
		return { response: internalError(error, "resolve service scope") };
	}
}

async function writeScope(request: Request, context: PublicServiceContext) {
	const auth = await requireApiKeyDeveloperRole(request);
	if (!auth.ok) return { response: auth.response };
	try {
		const params = await context.params;
		const service = await findNestedService(
			params.projectId,
			params.environmentId,
			params.serviceId,
		);
		return service ? { service, params, auth } : { response: notFound() };
	} catch (error) {
		return { response: internalError(error, "resolve service scope") };
	}
}

function cursorFilter<T extends { createdAt: unknown; id: unknown }>(
	table: T,
	cursor: TimestampCursor | undefined,
) {
	return cursor
		? or(
				lt(table.createdAt as never, sql`${cursor.createdAt}::timestamptz`),
				and(
					eq(table.createdAt as never, sql`${cursor.createdAt}::timestamptz`),
					lt(table.id as never, cursor.id),
				),
			)
		: undefined;
}
function internalError(error: unknown, operation: string) {
	console.error(`[public-api] ${operation} failed`, error);
	return apiError("Internal server error", "INTERNAL_ERROR", 500);
}

export async function getConfiguration(
	request: Request,
	context: PublicServiceContext,
) {
	const scope = await readScope(request, context);
	if ("response" in scope) return scope.response;
	try {
		return Response.json(await safeConfiguration(scope.service));
	} catch (error) {
		return internalError(error, "read configuration");
	}
}

export async function patchConfigurationRoute(
	request: Request,
	context: PublicServiceContext,
) {
	const scope = await writeScope(request, context);
	if ("response" in scope) return scope.response;
	const parsed = configurationPatchSchema.safeParse(
		await request.json().catch(() => null),
	);
	if (!parsed.success) {
		return badRequest(
			parsed.error.issues[0]?.message ?? "Invalid configuration",
		);
	}
	try {
		return Response.json(await patchConfiguration(scope.service, parsed.data));
	} catch (error) {
		return isPublicApiDomainError(error)
			? publicApiDomainResponse(error)
			: internalError(error, "patch configuration");
	}
}

const safeDeployment = {
	id: deployments.id,
	serviceRevisionId: deployments.serviceRevisionId,
	rolloutId: deployments.rolloutId,
	serverId: deployments.serverId,
	serverName: servers.name,
	desiredState: deployments.runtimeDesiredState,
	trafficState: deployments.trafficState,
	phase: deployments.observedPhase,
	healthStatus: deployments.healthStatus,
	failedStage: deployments.failedStage,
	createdAt: deployments.createdAt,
};
const safeRollout = {
	id: rollouts.id,
	serviceRevisionId: rollouts.serviceRevisionId,
	status: rollouts.status,
	currentStage: rollouts.currentStage,
	createdAt: rollouts.createdAt,
	completedAt: rollouts.completedAt,
};
const safeBuild = {
	id: builds.id,
	serviceRevisionId: builds.serviceRevisionId,
	commitSha: builds.commitSha,
	commitMessage: builds.commitMessage,
	branch: builds.branch,
	author: builds.author,
	status: builds.status,
	targetPlatform: builds.targetPlatform,
	startedAt: builds.startedAt,
	completedAt: builds.completedAt,
	createdAt: builds.createdAt,
};
const paginatedRollout = {
	...safeRollout,
	cursorCreatedAt: sql<string>`${rollouts.createdAt}::text`,
};
const paginatedBuild = {
	...safeBuild,
	cursorCreatedAt: sql<string>`${builds.createdAt}::text`,
};

export async function getStatus(
	request: Request,
	context: PublicServiceContext,
) {
	const scope = await readScope(request, context);
	if ("response" in scope) return scope.response;
	try {
		const [latestRollout, latestBuild, persisted, source] = await Promise.all([
			db
				.select(safeRollout)
				.from(rollouts)
				.where(eq(rollouts.serviceId, scope.service.id))
				.orderBy(desc(rollouts.createdAt), desc(rollouts.id))
				.limit(1)
				.then((rows) => rows[0] ?? null),
			db
				.select(safeBuild)
				.from(builds)
				.where(eq(builds.serviceId, scope.service.id))
				.orderBy(desc(builds.createdAt), desc(builds.id))
				.limit(1)
				.then((rows) => rows[0] ?? null),
			db
				.select(safeDeployment)
				.from(deployments)
				.innerJoin(servers, eq(servers.id, deployments.serverId))
				.where(eq(deployments.serviceId, scope.service.id))
				.orderBy(desc(deployments.createdAt))
				.limit(100),
			resolvePersistedSource(scope.service),
		]);
		return Response.json({
			service: {
				id: scope.service.id,
				name: scope.service.name,
				source,
			},
			latestBuild: scope.service.sourceType === "github" ? latestBuild : null,
			latestRollout,
			deployments: persisted,
		});
	} catch (error) {
		return internalError(error, "read status");
	}
}

function deployConflict(error: unknown) {
	const message = error instanceof Error ? error.message : "Deployment failed";
	if (
		/replica|placement|server|migration|GitHub repository|GitHub service/i.test(
			message,
		)
	) {
		return apiError(message, "DEPLOYMENT_CONFLICT", 409);
	}
	return apiError(
		"Deployment provider unavailable",
		"DEPLOY_PROVIDER_ERROR",
		502,
	);
}

export async function postDeploy(
	request: Request,
	context: PublicServiceContext,
) {
	const scope = await writeScope(request, context);
	if ("response" in scope) return scope.response;
	const actor = {
		type: "user" as const,
		userId: scope.auth.session.user.id,
		name: scope.auth.session.user.name,
	};
	try {
		const result = await deployServiceInternal(scope.service.id, actor, {
			githubTrigger: "manual",
		});
		if (
			scope.service.sourceType === "github" &&
			!("migrationStarted" in result)
		) {
			return Response.json(
				{
					operation: "build",
					status: "build_queued",
					rolloutId: null,
					buildId: "buildId" in result ? result.buildId : null,
				},
				{ status: 202 },
			);
		}
		return Response.json(
			{
				operation: "rollout",
				status: "migrationStarted" in result ? "migration_started" : "queued",
				rolloutId: "rolloutId" in result ? result.rolloutId : null,
				buildId: null,
			},
			{ status: 202 },
		);
	} catch (error) {
		return deployConflict(error);
	}
}

function waitForPoll(delayMs: number, signal?: AbortSignal) {
	if (signal?.aborted || delayMs <= 0) return Promise.resolve();
	return new Promise<void>((resolve) => {
		let timer: ReturnType<typeof setTimeout>;
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		timer = setTimeout(finish, delayMs);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

export async function longPollLogs<T extends { logs: unknown[] }>(
	query: () => Promise<T>,
	options: { waitMs: number; signal?: AbortSignal; intervalMs?: number },
) {
	if (options.signal?.aborted) {
		throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
	}
	const deadline = Date.now() + options.waitMs;
	let result = await query();
	while (
		result.logs.length === 0 &&
		Date.now() < deadline &&
		!options.signal?.aborted
	) {
		await waitForPoll(
			Math.min(options.intervalMs ?? 500, Math.max(0, deadline - Date.now())),
			options.signal,
		);
		if (!options.signal?.aborted && Date.now() < deadline) {
			result = await query();
		}
	}
	return result;
}

type ServiceLogCursorV1 = {
	v: 1;
	t: string;
	e: string;
};

export function encodeServiceLogCursor(cursor: ServiceLogCursorV1): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeServiceLogCursor(
	value: string | null,
): ServiceLogCursorV1 | null | undefined {
	if (!value) return undefined;
	if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
	try {
		const parsed = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		) as Partial<ServiceLogCursorV1>;
		if (
			parsed.v !== 1 ||
			typeof parsed.t !== "string" ||
			!isLogCursor(parsed.t) ||
			typeof parsed.e !== "string" ||
			(parsed.e !== "" && !isPublicServiceLogEventId(parsed.e))
		) {
			return null;
		}
		return { v: 1, t: parsed.t, e: parsed.e };
	} catch {
		return null;
	}
}

function logOptions(url: URL) {
	const rawCursor = url.searchParams.get("cursor");
	const cursor = decodeServiceLogCursor(rawCursor);
	if (cursor === null) throw new RangeError("Invalid log cursor");
	if (url.searchParams.has("after") || url.searchParams.has("before")) {
		throw new RangeError("Use the opaque cursor parameter for log pagination");
	}
	const rangeValue = url.searchParams.get("range");
	const range = rangeValue
		? LOG_TIME_RANGES.find((value) => value === rangeValue)
		: DEFAULT_LOG_TIME_RANGE;
	if (rangeValue && !range) throw new RangeError("Invalid log range");
	const waitRaw = url.searchParams.get("wait");
	const wait = waitRaw === null ? 0 : Number(waitRaw);
	if (!Number.isInteger(wait) || wait < 0 || wait > 20) {
		throw new RangeError("wait must be an integer from 0 to 20");
	}
	return {
		limit: parseLogLimit(
			url.searchParams.get("limit") ?? url.searchParams.get("tail"),
			100,
		),
		cursor,
		rawCursor,
		range,
		search: normalizeLogSearch(url.searchParams.get("q")),
		wait,
	};
}

function invalidLogQuery(error: RangeError) {
	return badRequest(error.message, "INVALID_LOG_QUERY");
}

function publicServiceLog(log: StoredLog) {
	return {
		deploymentId: log.deployment_id ?? null,
		stream: log.stream ?? "stdout",
		message: log._msg,
		timestamp: log._time,
	};
}

export function nextServiceLogCursor(
	logs: StoredLog[],
	rawCursor: string | null,
): string {
	const lastIdentified = logs.findLast((log) =>
		isPublicServiceLogEventId(log.event_id),
	);
	const eventId = lastIdentified?.event_id;
	if (lastIdentified && eventId) {
		return encodeServiceLogCursor({
			v: 1,
			t: lastIdentified._time,
			e: eventId,
		});
	}
	const last = logs.at(-1);
	if (last) {
		return encodeServiceLogCursor({ v: 1, t: last._time, e: "" });
	}
	if (rawCursor) return rawCursor;
	return encodeServiceLogCursor({
		v: 1,
		t: new Date(Date.now() - 15_000).toISOString(),
		e: "",
	});
}

export async function getServiceLogs(
	request: Request,
	context: PublicServiceContext,
) {
	const scope = await readScope(request, context);
	if ("response" in scope) return scope.response;
	if (!isLoggingEnabled()) {
		return Response.json({
			provider: "disabled",
			logs: [],
			nextCursor: null,
			hasMore: false,
			pollAfterMs: 2000,
		});
	}
	try {
		const options = logOptions(new URL(request.url));
		const query = () =>
			queryPublicServiceLogs({
				serviceId: scope.service.id,
				logType: "container",
				limit: options.limit,
				cursor: options.cursor
					? ({
							time: options.cursor.t,
							eventId: options.cursor.e,
						} satisfies PublicServiceLogCursor)
					: undefined,
				range: options.range,
				search: options.search,
				signal: request.signal,
			});
		const result =
			options.cursor && options.wait > 0
				? await longPollLogs(query, {
						waitMs: options.wait * 1000,
						signal: request.signal,
					})
				: await query();
		return Response.json({
			provider: "enabled",
			logs: result.logs.map(publicServiceLog),
			nextCursor: nextServiceLogCursor(result.logs, options.rawCursor),
			hasMore: result.hasMore,
			pollAfterMs: result.hasMore ? 0 : result.logs.length > 0 ? 250 : 1000,
		});
	} catch (error) {
		if (request.signal.aborted) return new Response(null, { status: 499 });
		if (error instanceof ServiceLogCursorUnavailableError) {
			return apiError(error.message, "LOG_CURSOR_UNAVAILABLE", 409);
		}
		return error instanceof RangeError
			? invalidLogQuery(error)
			: apiError("Log provider unavailable", "LOG_PROVIDER_ERROR", 502);
	}
}

export async function getRollouts(
	request: Request,
	context: PublicServiceContext,
) {
	const scope = await readScope(request, context);
	if ("response" in scope) return scope.response;
	let page: ReturnType<typeof timestampPage>;
	try {
		page = timestampPage(new URL(request.url));
	} catch (error) {
		return badRequest((error as Error).message, "INVALID_CURSOR");
	}
	try {
		const rows = await db
			.select(paginatedRollout)
			.from(rollouts)
			.where(
				and(
					eq(rollouts.serviceId, scope.service.id),
					cursorFilter(rollouts, page.cursor),
				),
			)
			.orderBy(desc(rollouts.createdAt), desc(rollouts.id))
			.limit(page.limit + 1);
		const pageRows = rows.slice(0, page.limit);
		const ids = pageRows.map((row) => row.id);
		const states = ids.length
			? await db
					.select(safeDeployment)
					.from(deployments)
					.innerJoin(servers, eq(servers.id, deployments.serverId))
					.where(
						and(
							eq(deployments.serviceId, scope.service.id),
							inArray(deployments.rolloutId, ids),
						),
					)
			: [];
		return Response.json({
			rollouts: pageRows.map(({ cursorCreatedAt: _, ...rollout }) => ({
				...rollout,
				deployments: states.filter(
					(deployment) => deployment.rolloutId === rollout.id,
				),
			})),
			nextCursor: nextTimestampCursor(rows, page.limit),
		});
	} catch (error) {
		return internalError(error, "list rollouts");
	}
}

type RolloutContext = PublicServiceContext & {
	params: Promise<PublicServiceParams & { rolloutId: string }>;
};

export async function getRollout(request: Request, context: RolloutContext) {
	const scope = await readScope(request, context);
	if ("response" in scope) return scope.response;
	const rolloutId = (await context.params).rolloutId;
	try {
		const rollout = await db
			.select(safeRollout)
			.from(rollouts)
			.where(
				and(
					eq(rollouts.id, rolloutId),
					eq(rollouts.serviceId, scope.service.id),
				),
			)
			.limit(1)
			.then((rows) => rows[0]);
		if (!rollout) return notFound();
		const state = await db
			.select(safeDeployment)
			.from(deployments)
			.innerJoin(servers, eq(servers.id, deployments.serverId))
			.where(
				and(
					eq(deployments.rolloutId, rollout.id),
					eq(deployments.serviceId, scope.service.id),
				),
			);
		return Response.json({ rollout: { ...rollout, deployments: state } });
	} catch (error) {
		return internalError(error, "read rollout");
	}
}

export async function getRolloutLogs(
	request: Request,
	context: RolloutContext,
) {
	const scope = await readScope(request, context);
	if ("response" in scope) return scope.response;
	let rolloutId: string;
	try {
		rolloutId = (await context.params).rolloutId;
		const exists = await db
			.select({ id: rollouts.id })
			.from(rollouts)
			.where(
				and(
					eq(rollouts.id, rolloutId),
					eq(rollouts.serviceId, scope.service.id),
				),
			)
			.limit(1)
			.then((rows) => rows[0]);
		if (!exists) return notFound();
	} catch (error) {
		return internalError(error, "resolve rollout logs scope");
	}
	if (!isLoggingEnabled()) {
		return Response.json({ provider: "disabled", logs: [] });
	}
	try {
		const url = new URL(request.url);
		const limit = parseLogLimit(url.searchParams.get("limit"), 100);
		const search = normalizeLogSearch(url.searchParams.get("q"));
		const result = await queryLogsByRollout(rolloutId, { limit, search });
		return Response.json({
			provider: "enabled",
			logs: result.logs.map((log) => ({
				stage: log.stage,
				message: log._msg,
				timestamp: log._time,
			})),
		});
	} catch (error) {
		return error instanceof RangeError
			? invalidLogQuery(error)
			: apiError("Log provider unavailable", "LOG_PROVIDER_ERROR", 502);
	}
}

export async function getBuilds(
	request: Request,
	context: PublicServiceContext,
) {
	const scope = await readScope(request, context);
	if ("response" in scope) return scope.response;
	if (scope.service.sourceType !== "github") {
		return Response.json({
			supported: false,
			reason: "IMAGE_SOURCE",
			builds: [],
			nextCursor: null,
		});
	}
	let page: ReturnType<typeof timestampPage>;
	try {
		page = timestampPage(new URL(request.url));
	} catch (error) {
		return badRequest((error as Error).message, "INVALID_CURSOR");
	}
	try {
		const rows = await db
			.select(paginatedBuild)
			.from(builds)
			.where(
				and(
					eq(builds.serviceId, scope.service.id),
					cursorFilter(builds, page.cursor),
				),
			)
			.orderBy(desc(builds.createdAt), desc(builds.id))
			.limit(page.limit + 1);
		return Response.json({
			supported: true,
			builds: rows
				.slice(0, page.limit)
				.map(({ cursorCreatedAt: _, ...build }) => build),
			nextCursor: nextTimestampCursor(rows, page.limit),
		});
	} catch (error) {
		return internalError(error, "list builds");
	}
}

export async function getMetrics(
	request: Request,
	context: PublicServiceContext,
) {
	const scope = await readScope(request, context);
	if ("response" in scope) return scope.response;
	const range = new URL(request.url).searchParams.get("range") ?? "1h";
	if (!METRIC_RANGE_KEYS.includes(range as never)) {
		return badRequest("Invalid metrics range", "INVALID_METRICS_RANGE");
	}
	if (!isMetricsEnabled()) {
		return Response.json({ provider: "disabled", metrics: null });
	}
	try {
		return Response.json({
			provider: "enabled",
			metrics: await queryServiceMetrics({
				serviceId: scope.service.id,
				range: range as (typeof METRIC_RANGE_KEYS)[number],
				throwOnError: true,
			}),
		});
	} catch {
		return apiError(
			"Metrics provider unavailable",
			"METRICS_PROVIDER_ERROR",
			502,
		);
	}
}

export async function getRevisions(
	request: Request,
	context: PublicServiceContext,
) {
	const scope = await readScope(request, context);
	if ("response" in scope) return scope.response;
	const cursorValue = new URL(request.url).searchParams.get("cursor");
	const cursor = decodeTimestampCursor(cursorValue);
	if (cursorValue && !cursor) {
		return badRequest("Invalid revision cursor", "INVALID_CURSOR");
	}
	try {
		const body = await queryServiceRevisionChangelog(
			scope.service.id,
			cursor ?? undefined,
		);
		return Response.json({
			...body,
			revisions: body.revisions.map((revision) =>
				revision.comparison.kind === "changes"
					? {
							...revision,
							comparison: {
								...revision.comparison,
								changes: revision.comparison.changes.filter(
									(change) => change.field !== "Secret",
								),
							},
						}
					: revision,
			),
		});
	} catch (error) {
		return internalError(error, "list revisions");
	}
}
