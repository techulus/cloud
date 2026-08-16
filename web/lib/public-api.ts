import { createHash, randomUUID } from "node:crypto";
import {
	and,
	desc,
	eq,
	inArray,
	isNull,
	ne,
	notInArray,
	sql,
} from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { db } from "@/db";
import {
	deployments,
	environments,
	githubRepos,
	projects,
	servers,
	serviceCrons,
	servicePorts,
	serviceReplicas,
	serviceRevisions,
	services,
	serviceVolumes,
} from "@/db/schema";
import { validateDockerImageInternal } from "@/lib/docker-image";
import { nameSchema } from "@/lib/schemas";
import { getServiceTotalReplicas } from "@/lib/service-config";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";
import {
	findServicePortValidationIssue,
	getDefaultServiceHostname,
	getServiceRevisionTotalReplicas,
} from "@/lib/service-revision-spec";

const githubPathPart = /^[A-Za-z0-9_.-]+$/;
const windowsAbsolutePath = /^[A-Za-z]:[\\/]/;

export function nextOccurrenceAfter(schedule: string, after: Date): Date {
	return CronExpressionParser.parse(schedule, {
		currentDate: after,
		tz: "UTC",
	})
		.next()
		.toDate();
}

export function isSafeCronPath(value: string): boolean {
	if (!value.startsWith("/") || value.startsWith("//") || value.length > 2048)
		return false;
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		return false;
	}
	if (
		!decoded.startsWith("/") ||
		decoded.startsWith("//") ||
		// eslint-disable-next-line no-control-regex -- Manifest paths must reject control characters.
		/[?#\\\u0000-\u001f\u007f]/.test(decoded)
	)
		return false;
	return !decoded.split("/").some((part) => part === "." || part === "..");
}

export const publicCronSchema = z.strictObject({
	path: z
		.string()
		.trim()
		.min(1)
		.max(2048)
		.refine(isSafeCronPath, "Invalid cron path"),
	schedule: z
		.string()
		.trim()
		.min(1)
		.max(255)
		.refine((value) => value.split(/\s+/).length === 5, {
			message: "Schedule must contain exactly five cron fields",
		})
		.refine((value) => {
			try {
				CronExpressionParser.parse(value, { tz: "UTC" });
				return true;
			} catch {
				return false;
			}
		}, "Invalid UTC cron expression"),
});

export function canonicalGitHubRepository(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("Invalid GitHub repository URL");
	}
	if (
		url.protocol !== "https:" ||
		url.hostname.toLowerCase() !== "github.com" ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"Repository must be an HTTPS github.com URL without credentials, port, query, or fragment",
		);
	}

	const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
	if (parts.length !== 2) throw new Error("Invalid GitHub repository path");
	const owner = parts[0];
	const repository = parts[1].replace(/\.git$/i, "");
	if (
		!owner ||
		!repository ||
		owner === "." ||
		owner === ".." ||
		repository === "." ||
		repository === ".." ||
		!githubPathPart.test(owner) ||
		!githubPathPart.test(repository)
	) {
		throw new Error("Invalid GitHub repository path");
	}
	return `https://github.com/${owner}/${repository}`;
}

export function isSafeRepositoryRoot(value: string): boolean {
	const rootDir = value.trim();
	if (
		!rootDir ||
		rootDir.startsWith("/") ||
		rootDir.startsWith("\\") ||
		windowsAbsolutePath.test(rootDir)
	) {
		return false;
	}
	return !rootDir.split(/[\\/]+/).includes("..");
}

const rootDirSchema = z
	.string()
	.trim()
	.max(512)
	.refine(
		isSafeRepositoryRoot,
		"rootDir must be repository-relative and cannot contain '..'",
	)
	.transform((value) => value.replaceAll("\\", "/"));
const githubRepositorySchema = z
	.string()
	.trim()
	.refine((value) => {
		try {
			canonicalGitHubRepository(value);
			return true;
		} catch {
			return false;
		}
	}, "Invalid GitHub repository URL")
	.transform(canonicalGitHubRepository);

export const publicSourceSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("image"),
		image: z.string().trim().min(1).max(2048),
	}),
	z.strictObject({
		type: z.literal("github"),
		repository: githubRepositorySchema,
		branch: z.string().trim().min(1).max(255),
		rootDir: rootDirSchema.nullable(),
	}),
]);

export type PublicSource =
	| { type: "image"; image: string }
	| {
			type: "github";
			repository: string | null;
			branch: string;
			rootDir: string | null;
	  };
export type NestedService = typeof services.$inferSelect;
type GitHubRepo = typeof githubRepos.$inferSelect;

function resolveRepository(
	service: NestedService,
	repo: GitHubRepo | undefined,
): string | null {
	if (repo?.repoFullName) {
		try {
			return canonicalGitHubRepository(
				`https://github.com/${repo.repoFullName}`,
			);
		} catch {
			return null;
		}
	}
	if (!service.githubRepoUrl) return null;
	try {
		return canonicalGitHubRepository(service.githubRepoUrl);
	} catch {
		return null;
	}
}

export function resolvePersistedSourceFromRows(
	service: NestedService,
	repo: GitHubRepo | undefined,
): PublicSource {
	if (service.sourceType === "image") {
		return { type: "image", image: service.image };
	}
	return {
		type: "github",
		repository: resolveRepository(service, repo),
		branch:
			repo?.deployBranch?.trim() ||
			repo?.defaultBranch?.trim() ||
			service.githubBranch?.trim() ||
			"main",
		rootDir: service.githubRootDir?.trim() || null,
	};
}

export async function resolvePersistedSource(
	service: NestedService,
): Promise<PublicSource> {
	if (service.sourceType === "image") {
		return { type: "image", image: service.image };
	}
	const repo = await db
		.select()
		.from(githubRepos)
		.where(eq(githubRepos.serviceId, service.id))
		.limit(1)
		.then((rows) => rows[0]);
	return resolvePersistedSourceFromRows(service, repo);
}

export async function findServiceContext(serviceId: string) {
	return db
		.select({
			service: services,
			projectId: projects.id,
			projectSlug: projects.slug,
			environmentId: environments.id,
			environmentName: environments.name,
		})
		.from(services)
		.innerJoin(projects, eq(projects.id, services.projectId))
		.innerJoin(
			environments,
			and(
				eq(environments.id, services.environmentId),
				eq(environments.projectId, projects.id),
			),
		)
		.where(
			and(
				eq(services.id, serviceId),
				isNull(services.deletedAt),
				isNull(services.previewOfServiceId),
			),
		)
		.limit(1)
		.then((rows) => rows[0] ?? null);
}

export function apiError(message: string, code: string, status: number) {
	return Response.json({ message, code }, { status });
}
export const notFound = () => apiError("Resource not found", "NOT_FOUND", 404);
export const badRequest = (message: string, code = "INVALID_REQUEST") =>
	apiError(message, code, 400);

type ManagementBlocker = { code: string; message: string };
function getManagementBlockers(input: {
	service: NestedService;
	source: PublicSource;
	ports: Array<typeof servicePorts.$inferSelect>;
	volumeCount: number;
}): ManagementBlocker[] {
	const blockers: ManagementBlocker[] = [];
	if (input.service.stateful || input.volumeCount > 0) {
		blockers.push({
			code: "UNSUPPORTED_STATEFUL_OR_VOLUMES",
			message: "Stateful services and volumes must be managed in the web UI",
		});
	}
	if (input.ports.some((port) => port.protocol !== "http")) {
		blockers.push({
			code: "UNSUPPORTED_PORT_PROTOCOL",
			message: "TCP and UDP ports must be managed in the web UI",
		});
	}
	if (
		input.ports.some(
			(port) => port.externalPort !== null || port.tlsPassthrough,
		)
	) {
		blockers.push({
			code: "UNSUPPORTED_PORT_OPTIONS",
			message:
				"External port allocation and TLS passthrough must be managed in the web UI",
		});
	}
	if (input.ports.some((port) => port.isPublic && !port.domain)) {
		blockers.push({
			code: "UNMANAGED_PUBLIC_PORT",
			message:
				"Public HTTP ports without domains must be managed in the web UI",
		});
	}
	if (
		(input.service.resourceCpuLimit === null) !==
		(input.service.resourceMemoryLimitMb === null)
	) {
		blockers.push({
			code: "INVALID_RESOURCE_LIMITS",
			message: "CPU and memory limits must both be set or both be cleared",
		});
	}
	if (input.source.type === "github") {
		if (!input.source.repository) {
			blockers.push({
				code: "INCOMPLETE_GITHUB_SOURCE",
				message: "Connect the service to a GitHub repository in the web UI",
			});
		}
		if (input.source.rootDir && !isSafeRepositoryRoot(input.source.rootDir)) {
			blockers.push({
				code: "INVALID_GITHUB_ROOT",
				message: "The configured GitHub root directory is unsafe",
			});
		}
	}
	return blockers;
}

function sanitizeSpec(specification: unknown) {
	const spec = parseServiceRevisionSpec(specification);
	const replicas = getServiceRevisionTotalReplicas(spec);
	const placement =
		spec.placement.mode === "automatic"
			? { mode: "automatic" as const, replicas, autoscaling: spec.autoscaling }
			: { mode: "manual" as const, placements: spec.placements, replicas };
	return {
		source:
			spec.source.type === "github"
				? {
						type: "github" as const,
						repository: spec.source.repository,
						branch: spec.source.branch,
						rootDir: spec.source.rootDir,
					}
				: { type: "image" as const, image: spec.source.image },
		hostname: spec.hostname,
		stateful: spec.stateful,
		placement,
		replicas,
		placements: spec.placements,
		healthCheck: spec.healthCheck,
		startCommand: spec.startCommand,
		resources: spec.resourceLimits,
		ports: spec.ports.map((port) => ({
			containerPort: port.containerPort,
			public: port.isPublic,
			domain: port.domain,
			protocol: port.protocol,
			externalPort: port.externalPort,
			tlsPassthrough: port.tlsPassthrough,
		})),
		volumes: spec.volumes,
		serverless: spec.serverless,
	};
}

export async function safeConfiguration(service: NestedService) {
	const [repo, ports, crons, volumes, placements, activeDeployment] =
		await Promise.all([
			db
				.select()
				.from(githubRepos)
				.where(eq(githubRepos.serviceId, service.id))
				.limit(1)
				.then((rows) => rows[0]),
			db
				.select()
				.from(servicePorts)
				.where(eq(servicePorts.serviceId, service.id)),
			db
				.select({ path: serviceCrons.path, schedule: serviceCrons.schedule })
				.from(serviceCrons)
				.where(eq(serviceCrons.serviceId, service.id)),
			db
				.select({
					name: serviceVolumes.name,
					containerPath: serviceVolumes.containerPath,
				})
				.from(serviceVolumes)
				.where(eq(serviceVolumes.serviceId, service.id)),
			db
				.select({
					serverId: serviceReplicas.serverId,
					serverName: servers.name,
					count: serviceReplicas.count,
				})
				.from(serviceReplicas)
				.innerJoin(servers, eq(servers.id, serviceReplicas.serverId))
				.where(eq(serviceReplicas.serviceId, service.id)),
			db
				.select({
					id: deployments.id,
					revisionId: deployments.serviceRevisionId,
				})
				.from(deployments)
				.where(
					and(
						eq(deployments.serviceId, service.id),
						eq(deployments.trafficState, "active"),
					),
				)
				.orderBy(desc(deployments.createdAt), desc(deployments.id))
				.limit(1)
				.then((rows) => rows[0] ?? null),
		]);

	const source = resolvePersistedSourceFromRows(service, repo);
	const sortedPlacements = placements.toSorted((a, b) =>
		a.serverId.localeCompare(b.serverId, "en"),
	);
	const sortedPorts = ports.toSorted(
		(a, b) =>
			a.port - b.port ||
			a.protocol.localeCompare(b.protocol, "en") ||
			(a.domain ?? "").localeCompare(b.domain ?? "", "en"),
	);
	const sortedVolumes = volumes.toSorted(
		(a, b) =>
			a.name.localeCompare(b.name, "en") ||
			a.containerPath.localeCompare(b.containerPath, "en"),
	);
	const sortedCrons = crons.toSorted((a, b) =>
		a.path.localeCompare(b.path, "en"),
	);
	const replicaCount = getServiceTotalReplicas({
		...service,
		configuredReplicas: sortedPlacements,
	});
	const placement =
		service.placementMode === "automatic"
			? {
					mode: "automatic" as const,
					replicas: replicaCount,
					autoscaling: service.autoscalingEnabled
						? {
								enabled: true as const,
								minReplicas: service.autoscalingMinReplicas,
								maxReplicas: service.autoscalingMaxReplicas,
							}
						: undefined,
				}
			: {
					mode: "manual" as const,
					placements: sortedPlacements,
					replicas: replicaCount,
				};
	const current = {
		source,
		hostname:
			service.hostname?.trim() ||
			getDefaultServiceHostname(service.name, service.id),
		stateful: service.stateful,
		replicas: replicaCount,
		placements: sortedPlacements,
		placement,
		healthCheck: service.healthCheckCmd
			? {
					cmd: service.healthCheckCmd,
					interval: service.healthCheckInterval ?? 10,
					timeout: service.healthCheckTimeout ?? 5,
					retries: service.healthCheckRetries ?? 3,
					startPeriod: service.healthCheckStartPeriod ?? 30,
				}
			: null,
		startCommand: service.startCommand,
		resources: {
			cpuCores: service.resourceCpuLimit,
			memoryMb: service.resourceMemoryLimitMb,
		},
		ports: sortedPorts.map((port) => ({
			containerPort: port.port,
			public: port.isPublic,
			domain: port.domain,
			protocol: port.protocol,
			externalPort: port.externalPort,
			tlsPassthrough: port.tlsPassthrough,
		})),
		volumes: sortedVolumes,
		crons: sortedCrons,
		serverless: {
			enabled: service.serverlessEnabled,
			sleepAfterSeconds: service.serverlessSleepAfterSeconds,
			wakeTimeoutSeconds: service.serverlessWakeTimeoutSeconds,
		},
		schedules: {
			deployment: service.deploymentSchedule,
			backup: {
				enabled: service.backupEnabled,
				schedule: service.backupSchedule,
			},
		},
	};

	let active: ReturnType<typeof sanitizeSpec> | null = null;
	if (activeDeployment) {
		const revision = await db
			.select({ specification: serviceRevisions.specification })
			.from(serviceRevisions)
			.where(
				and(
					eq(serviceRevisions.id, activeDeployment.revisionId),
					eq(serviceRevisions.serviceId, service.id),
				),
			)
			.limit(1)
			.then((rows) => rows[0]);
		try {
			active = revision ? sanitizeSpec(revision.specification) : null;
		} catch {
			active = null;
		}
	}

	const comparableCurrent = {
		source: current.source,
		hostname: current.hostname,
		stateful: current.stateful,
		placement:
			current.placement.mode === "automatic"
				? current.placement
				: {
						...current.placement,
						placements: current.placement.placements.map(
							({ serverId, count }) => ({ serverId, count }),
						),
					},
		healthCheck: current.healthCheck,
		startCommand: current.startCommand?.trim() || null,
		resources: current.resources,
		ports: current.ports,
		volumes: current.volumes,
		serverless: current.serverless,
	};
	const pendingChanges = active
		? Object.keys(comparableCurrent).flatMap((field) =>
				JSON.stringify(
					comparableCurrent[field as keyof typeof comparableCurrent],
				) === JSON.stringify(active[field as keyof typeof active])
					? []
					: [{ field, from: "active revision", to: "current configuration" }],
			)
		: [
				{
					field: "deployment",
					from: "no readable active revision",
					to: "current configuration",
				},
			];
	const blockers = getManagementBlockers({
		service,
		source,
		ports,
		volumeCount: volumes.length,
	});

	return {
		current,
		active,
		activeRevisionId: activeDeployment?.revisionId ?? null,
		activeDeploymentId: activeDeployment?.id ?? null,
		hasPendingChanges: pendingChanges.length > 0,
		changes: pendingChanges,
		management: { patchable: blockers.length === 0, blockers },
	};
}

const healthCheckSchema = z.strictObject({
	cmd: z.string().trim().min(1).max(2048),
	interval: z.number().int().min(1),
	timeout: z.number().int().min(1),
	retries: z.number().int().min(1),
	startPeriod: z.number().int().min(0),
});
const portSchema = z
	.strictObject({
		containerPort: z.number().int().min(1).max(65535),
		public: z.boolean(),
		domain: z
			.string()
			.trim()
			.min(1)
			.max(253)
			.transform((value) => value.toLowerCase())
			.nullable()
			.optional(),
	})
	.superRefine((port, context) => {
		if (port.public && !port.domain) {
			context.addIssue({
				code: "custom",
				path: ["domain"],
				message: "Public HTTP ports require a domain",
			});
		}
		if (!port.public && port.domain) {
			context.addIssue({
				code: "custom",
				path: ["domain"],
				message: "Internal ports cannot define a domain",
			});
		}
	});
const hostnameSchema = z
	.string()
	.trim()
	.toLowerCase()
	.min(1)
	.max(63)
	.regex(
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
		"hostname must contain only lowercase letters, numbers, and hyphens",
	);
const autoscalingRangeSchema = z
	.strictObject({
		enabled: z.literal(true).optional(),
		minReplicas: z.number().int().min(1).max(32),
		maxReplicas: z.number().int().min(1).max(32),
	})
	.refine((value) => value.minReplicas <= value.maxReplicas, {
		message: "Minimum replicas cannot exceed maximum replicas",
	});
export const placementSchema = z.union([
	z.strictObject({
		mode: z.literal("automatic"),
		replicas: z.number().int().min(1).max(32),
	}),
	z.strictObject({
		mode: z.literal("automatic"),
		replicas: z.number().int().min(1).max(32).optional(),
		autoscaling: autoscalingRangeSchema,
	}),
	z
		.strictObject({
			mode: z.literal("manual"),
			placements: z
				.array(
					z.strictObject({
						serverId: z.string().min(1),
						count: z.number().int().min(1).max(32),
					}),
				)
				.min(1),
		})
		.superRefine((value, context) => {
			if (
				new Set(value.placements.map((item) => item.serverId)).size !==
				value.placements.length
			)
				context.addIssue({
					code: "custom",
					message: "Server IDs must be unique",
					path: ["placements"],
				});
			if (value.placements.reduce((sum, item) => sum + item.count, 0) > 32)
				context.addIssue({
					code: "custom",
					message: "Total replicas must be between 1 and 32",
					path: ["placements"],
				});
		}),
]);
export const replaceConfigurationSchema = z.strictObject({
	name: nameSchema,
	source: publicSourceSchema,
	hostname: hostnameSchema,
	ports: z.array(portSchema).max(100),
	placement: placementSchema,
	healthCheck: healthCheckSchema.nullable(),
	startCommand: z.string().trim().min(1).max(4096).nullable(),
	resources: z
		.strictObject({
			cpuCores: z.number().min(0.1).max(64).nullable(),
			memoryMb: z.number().int().min(64).max(65536).nullable(),
		})
		.refine(
			(value) => (value.cpuCores === null) === (value.memoryMb === null),
			"CPU and memory limits must both be set or both be null",
		)
		.nullable(),
	crons: z
		.array(publicCronSchema)
		.max(100)
		.superRefine((crons, context) => {
			if (new Set(crons.map((cron) => cron.path)).size !== crons.length)
				context.addIssue({
					code: "custom",
					message: "Cron paths must be unique",
				});
		}),
});

type PublicApiDomainError = Error & { code: string; status: number };
function domainError(message: string, code: string, status = 409): never {
	throw Object.assign(new Error(message), {
		code,
		status,
	}) as PublicApiDomainError;
}
export function isPublicApiDomainError(
	error: unknown,
): error is PublicApiDomainError {
	const value = error as Partial<PublicApiDomainError>;
	return (
		error instanceof Error &&
		typeof value.code === "string" &&
		typeof value.status === "number"
	);
}
export function publicApiDomainResponse(error: PublicApiDomainError) {
	return apiError(error.message, error.code, error.status);
}

function healthCheckFromService(service: NestedService) {
	return service.healthCheckCmd
		? {
				cmd: service.healthCheckCmd,
				interval: service.healthCheckInterval ?? 10,
				timeout: service.healthCheckTimeout ?? 5,
				retries: service.healthCheckRetries ?? 3,
				startPeriod: service.healthCheckStartPeriod ?? 30,
			}
		: null;
}

type ReplacementInput = z.infer<typeof replaceConfigurationSchema>;
type CanonicalReplacementInput = Omit<ReplacementInput, "crons"> & {
	crons?: ReplacementInput["crons"];
};
type ConfigurationChange = { field: string; from: unknown; to: unknown };

function canonicalPlanSource(source: PublicSource) {
	return source.type === "github"
		? {
				...source,
				repository: source.repository?.toLowerCase() ?? null,
			}
		: source;
}

function canonicalReplacementState(
	service: NestedService,
	source: ReturnType<typeof resolvePersistedSourceFromRows>,
	ports: Array<{ port: number; isPublic: boolean; domain: string | null }>,
	placements: Array<{ serverId: string; count: number }>,
	crons: Array<{ path: string; schedule: string }>,
) {
	const resources =
		service.resourceCpuLimit == null && service.resourceMemoryLimitMb == null
			? null
			: {
					cpuCores: service.resourceCpuLimit,
					memoryMb: service.resourceMemoryLimitMb,
				};
	return {
		name: service.name,
		source: canonicalPlanSource(source),
		hostname:
			service.hostname?.trim() ||
			getDefaultServiceHostname(service.name, service.id),
		ports: ports
			.map((port) => ({
				containerPort: port.port,
				public: port.isPublic,
				domain: port.domain,
			}))
			.toSorted(
				(a, b) =>
					a.containerPort - b.containerPort ||
					Number(a.public) - Number(b.public) ||
					(a.domain ?? "").localeCompare(b.domain ?? "", "en"),
			),
		placement:
			service.placementMode === "automatic"
				? service.autoscalingEnabled
					? {
							mode: "automatic" as const,
							autoscaling: {
								minReplicas: service.autoscalingMinReplicas,
								maxReplicas: service.autoscalingMaxReplicas,
							},
						}
					: { mode: "automatic" as const, replicas: service.replicas }
				: {
						mode: "manual" as const,
						placements: placements
							.map(({ serverId, count }) => ({ serverId, count }))
							.toSorted((a, b) => a.serverId.localeCompare(b.serverId, "en")),
					},
		healthCheck: healthCheckFromService(service),
		startCommand: service.startCommand?.trim() || null,
		resources,
		crons: crons
			.map(({ path, schedule }) => ({ path, schedule }))
			.toSorted((a, b) => a.path.localeCompare(b.path, "en")),
		serverless: { enabled: service.serverlessEnabled },
	};
}

export function canonicalDesired(input: CanonicalReplacementInput) {
	return {
		...input,
		source: canonicalPlanSource(input.source),
		ports: input.ports
			.map((port) => ({
				...port,
				domain: port.domain ?? null,
			}))
			.toSorted(
				(a, b) =>
					a.containerPort - b.containerPort ||
					Number(a.public) - Number(b.public) ||
					(a.domain ?? "").localeCompare(b.domain ?? "", "en"),
			),
		placement:
			input.placement.mode === "manual"
				? {
						...input.placement,
						placements: input.placement.placements.toSorted((a, b) =>
							a.serverId.localeCompare(b.serverId, "en"),
						),
					}
				: "autoscaling" in input.placement
					? {
							mode: "automatic" as const,
							autoscaling: {
								minReplicas: input.placement.autoscaling.minReplicas,
								maxReplicas: input.placement.autoscaling.maxReplicas,
							},
						}
					: input.placement,
		crons: (input.crons ?? []).toSorted((a, b) =>
			a.path.localeCompare(b.path, "en"),
		),
	};
}

function fingerprint(value: unknown) {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function configurationChanges(
	current: Record<string, unknown>,
	desired: Record<string, unknown>,
) {
	const changes: ConfigurationChange[] = [];
	const compare = (field: string, from: unknown, to: unknown) => {
		if (JSON.stringify(from) === JSON.stringify(to)) return;
		if (
			from !== null &&
			to !== null &&
			typeof from === "object" &&
			typeof to === "object" &&
			!Array.isArray(from) &&
			!Array.isArray(to)
		) {
			for (const key of new Set([
				...Object.keys(from as Record<string, unknown>),
				...Object.keys(to as Record<string, unknown>),
			]))
				compare(
					`${field}.${key}`,
					(from as Record<string, unknown>)[key],
					(to as Record<string, unknown>)[key],
				);
			return;
		}
		changes.push({
			field,
			from: from === undefined ? null : from,
			to: to === undefined ? null : to,
		});
	};
	for (const field of Object.keys(desired))
		compare(field, current[field], desired[field]);
	return changes;
}

export function planCanonicalConfiguration(
	current: Omit<ReturnType<typeof canonicalReplacementState>, "crons"> & {
		crons?: Array<{ path: string; schedule: string }>;
	},
	desiredInput: CanonicalReplacementInput,
) {
	const { serverless, ...currentWithoutServerless } = current;
	const canonicalCurrent = {
		...currentWithoutServerless,
		source: canonicalPlanSource(current.source),
		crons: (current.crons ?? [])
			.map(({ path, schedule }) => ({ path, schedule }))
			.toSorted((a, b) => a.path.localeCompare(b.path, "en")),
		serverless,
	};
	const desiredConfiguration = canonicalDesired(desiredInput);
	const desired = {
		...desiredConfiguration,
		serverless: {
			enabled:
				canonicalCurrent.serverless.enabled &&
				desiredConfiguration.ports.some((port) => port.public && port.domain),
		},
	};
	const changes = configurationChanges(canonicalCurrent, desired);
	return {
		action: changes.length ? ("updated" as const) : ("noop" as const),
		currentVersion: fingerprint(canonicalCurrent),
		desiredVersion: fingerprint(desired),
		changes,
	};
}

export async function planConfiguration(
	service: NestedService,
	input: ReplacementInput,
) {
	return replaceConfigurationInternal(service, input, null);
}

export async function replaceConfiguration(
	service: NestedService,
	input: ReplacementInput,
	expectedVersion: string,
) {
	const { targetServiceName: _, ...plan } = await replaceConfigurationInternal(
		service,
		input,
		expectedVersion,
	);
	return plan;
}

async function replaceConfigurationInternal(
	service: NestedService,
	input: ReplacementInput,
	expectedVersion: string | null,
) {
	let imageValidated = false;
	if (
		input.source.type === "image" &&
		(service.sourceType !== "image" || input.source.image !== service.image)
	) {
		const validation = await validateDockerImageInternal(input.source.image);
		if (!validation.valid) {
			domainError(validation.error || "Invalid image", "INVALID_IMAGE", 400);
		}
		imageValidated = true;
	}

	return db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext(${service.id}))`,
		);
		const persisted = await tx
			.select()
			.from(services)
			.where(and(eq(services.id, service.id), isNull(services.deletedAt)))
			.limit(1)
			.then((rows) => rows[0]);
		if (!persisted) domainError("Service not found", "NOT_FOUND", 404);
		const [ports, volumes, placements, repo, crons] = await Promise.all([
			tx
				.select()
				.from(servicePorts)
				.where(eq(servicePorts.serviceId, service.id)),
			tx
				.select()
				.from(serviceVolumes)
				.where(eq(serviceVolumes.serviceId, service.id)),
			tx
				.select()
				.from(serviceReplicas)
				.where(eq(serviceReplicas.serviceId, service.id)),
			tx
				.select()
				.from(githubRepos)
				.where(eq(githubRepos.serviceId, service.id))
				.limit(1)
				.then((rows) => rows[0]),
			tx
				.select()
				.from(serviceCrons)
				.where(eq(serviceCrons.serviceId, service.id)),
		]);
		const source = resolvePersistedSourceFromRows(persisted, repo);
		const currentState = canonicalReplacementState(
			persisted,
			source,
			ports,
			placements,
			crons,
		);
		if (
			input.source.type === "image" &&
			input.source.image !== persisted.image &&
			!imageValidated
		) {
			domainError(
				"Service image changed while the configuration was being validated",
				"CONFIGURATION_PLAN_STALE",
			);
		}
		const plan = planCanonicalConfiguration(currentState, input);
		const effectiveServerlessEnabled =
			persisted.serverlessEnabled &&
			input.ports.some((port) => port.public && port.domain);
		if (expectedVersion !== null && plan.currentVersion !== expectedVersion) {
			domainError(
				"Service configuration changed after the plan was created",
				"CONFIGURATION_PLAN_STALE",
			);
		}
		if (
			input.placement.mode === "automatic" &&
			(persisted.stateful || volumes.length > 0)
		) {
			domainError(
				"Automatic placement is not supported for stateful or volume-backed services",
				"AUTOMATIC_PLACEMENT_UNSUPPORTED",
				400,
			);
		}
		if (
			input.placement.mode === "automatic" &&
			"autoscaling" in input.placement
		) {
			if (effectiveServerlessEnabled)
				domainError(
					"Autoscaling is not supported for serverless services",
					"AUTOSCALING_UNSUPPORTED",
					400,
				);
			if (input.resources?.cpuCores == null || input.resources.memoryMb == null)
				domainError(
					"Autoscaling requires both CPU and memory limits",
					"AUTOSCALING_RESOURCE_LIMITS_REQUIRED",
					400,
				);
		}
		const blockers = getManagementBlockers({
			service: persisted,
			source,
			ports,
			volumeCount: volumes.length,
		});
		if (blockers[0]) {
			domainError(blockers[0].message, blockers[0].code);
		}

		if (input.source.type !== persisted.sourceType) {
			domainError(
				"Source type conversion is not supported; change the source in the web UI",
				"SOURCE_TYPE_CONVERSION",
			);
		}
		if (input.source.type === "github") {
			if (source.type !== "github" || !source.repository) {
				domainError(
					"The service does not have a valid linked GitHub repository",
					"INCOMPLETE_GITHUB_SOURCE",
				);
			}
			if (
				input.source.repository.toLowerCase() !==
				source.repository.toLowerCase()
			) {
				domainError(
					"GitHub repository switching is not supported; relink it in the web UI",
					"GITHUB_REPOSITORY_SWITCH",
				);
			}
		}
		if (input.placement.mode === "manual") {
			const ids = input.placement.placements.map((item) => item.serverId);
			const selected = await tx
				.select({
					id: servers.id,
					isProxy: servers.isProxy,
					status: servers.status,
					wireguardIp: servers.wireguardIp,
				})
				.from(servers)
				.where(inArray(servers.id, ids));
			if (selected.length !== ids.length)
				domainError(
					"One or more selected servers do not exist",
					"INVALID_PLACEMENT",
					400,
				);
			if (
				selected.some(
					(server) => server.status !== "online" || !server.wireguardIp,
				)
			)
				domainError(
					"Manual placement requires online, configured servers",
					"INVALID_PLACEMENT",
					400,
				);
			if (
				effectiveServerlessEnabled &&
				selected.some((server) => !server.isProxy)
			)
				domainError(
					"Serverless services can only be deployed to proxy nodes",
					"SERVERLESS_PROXY_REQUIRED",
					400,
				);
		}

		const duplicateHostname = await tx
			.select({ id: services.id })
			.from(services)
			.where(
				and(eq(services.hostname, input.hostname), ne(services.id, service.id)),
			)
			.limit(1)
			.then((rows) => rows[0]);
		if (duplicateHostname) {
			domainError("Hostname is already in use", "HOSTNAME_CONFLICT");
		}
		const portIssue = findServicePortValidationIssue(
			input.ports.map((port) => ({
				containerPort: port.containerPort,
				isPublic: port.public,
				domain: port.domain ?? null,
				protocol: "http" as const,
			})),
		);
		if (portIssue) {
			domainError(portIssue.message, portIssue.code, 400);
		}
		const domains = input.ports.flatMap((port) =>
			port.public && port.domain ? [port.domain] : [],
		);
		for (const domain of domains) {
			const duplicate = await tx
				.select({ id: servicePorts.id })
				.from(servicePorts)
				.where(
					and(
						eq(servicePorts.domain, domain),
						ne(servicePorts.serviceId, service.id),
					),
				)
				.limit(1)
				.then((rows) => rows[0]);
			if (duplicate) {
				domainError("Port domain is already in use", "DOMAIN_CONFLICT");
			}
		}
		if (expectedVersion === null) {
			return { targetServiceName: persisted.name, ...plan };
		}

		const changes: string[] = [];
		const set: Partial<NestedService> = {};
		if (persisted.serverlessEnabled !== effectiveServerlessEnabled) {
			set.serverlessEnabled = effectiveServerlessEnabled;
		}
		const changed = (label: string, from: unknown, to: unknown) => {
			if (JSON.stringify(from) === JSON.stringify(to)) return false;
			changes.push(label);
			return true;
		};
		if (changed("name", persisted.name, input.name)) set.name = input.name;

		const hostnameChanged = changed(
			"hostname",
			currentState.hostname,
			input.hostname,
		);
		if (!persisted.hostname?.trim() || hostnameChanged) {
			set.hostname = input.hostname;
		}
		if (
			changed("startCommand", currentState.startCommand, input.startCommand)
		) {
			set.startCommand = input.startCommand;
		}
		if (
			changed(
				"healthCheck",
				healthCheckFromService(persisted),
				input.healthCheck,
			)
		) {
			Object.assign(
				set,
				input.healthCheck
					? {
							healthCheckCmd: input.healthCheck.cmd,
							healthCheckInterval: input.healthCheck.interval,
							healthCheckTimeout: input.healthCheck.timeout,
							healthCheckRetries: input.healthCheck.retries,
							healthCheckStartPeriod: input.healthCheck.startPeriod,
						}
					: {
							healthCheckCmd: null,
							healthCheckInterval: null,
							healthCheckTimeout: null,
							healthCheckRetries: null,
							healthCheckStartPeriod: null,
						},
			);
		}
		if (
			changed(
				"resources",
				persisted.resourceCpuLimit == null &&
					persisted.resourceMemoryLimitMb == null
					? null
					: {
							cpuCores: persisted.resourceCpuLimit,
							memoryMb: persisted.resourceMemoryLimitMb,
						},
				input.resources,
			)
		) {
			set.resourceCpuLimit = input.resources?.cpuCores ?? null;
			set.resourceMemoryLimitMb = input.resources?.memoryMb ?? null;
		}
		if (
			input.source.type === "image" &&
			changed("source.image", persisted.image, input.source.image)
		) {
			set.image = input.source.image;
		}
		if (input.placement) {
			const requestedPlacement =
				input.placement.mode === "automatic" && "autoscaling" in input.placement
					? {
							mode: "automatic" as const,
							autoscaling: {
								minReplicas: input.placement.autoscaling.minReplicas,
								maxReplicas: input.placement.autoscaling.maxReplicas,
							},
						}
					: input.placement;
			const desiredReplicas =
				input.placement.mode === "automatic"
					? "autoscaling" in input.placement
						? Math.min(
								input.placement.autoscaling.maxReplicas,
								Math.max(
									input.placement.autoscaling.minReplicas,
									persisted.replicas,
								),
							)
						: input.placement.replicas
					: input.placement.placements.reduce(
							(sum, item) => sum + item.count,
							0,
						);
			if (
				changed(
					"placement",
					persisted.placementMode === "automatic"
						? persisted.autoscalingEnabled
							? {
									mode: "automatic",
									autoscaling: {
										minReplicas: persisted.autoscalingMinReplicas,
										maxReplicas: persisted.autoscalingMaxReplicas,
									},
								}
							: { mode: "automatic", replicas: persisted.replicas }
						: {
								mode: "manual",
								placements: placements
									.map(({ serverId, count }) => ({ serverId, count }))
									.toSorted((a, b) => a.serverId.localeCompare(b.serverId)),
							},
					requestedPlacement.mode === "manual"
						? {
								...requestedPlacement,
								placements: requestedPlacement.placements.toSorted((a, b) =>
									a.serverId.localeCompare(b.serverId),
								),
							}
						: requestedPlacement,
				)
			) {
				set.placementMode = input.placement.mode;
				set.replicas = desiredReplicas;
				set.autoscalingEnabled =
					input.placement.mode === "automatic" &&
					"autoscaling" in input.placement;
				set.autoscalingMinReplicas =
					input.placement.mode === "automatic" &&
					"autoscaling" in input.placement
						? input.placement.autoscaling.minReplicas
						: desiredReplicas;
				set.autoscalingMaxReplicas =
					input.placement.mode === "automatic" &&
					"autoscaling" in input.placement
						? input.placement.autoscaling.maxReplicas
						: desiredReplicas;
				await tx
					.delete(serviceReplicas)
					.where(eq(serviceReplicas.serviceId, service.id));
				if (input.placement.mode === "manual")
					await tx.insert(serviceReplicas).values(
						input.placement.placements.map((item) => ({
							id: randomUUID(),
							serviceId: service.id,
							...item,
						})),
					);
			}
		}
		if (input.source.type === "github") {
			const effectiveBranch =
				repo?.deployBranch ||
				repo?.defaultBranch ||
				persisted.githubBranch ||
				"main";
			if (changed("source.branch", effectiveBranch, input.source.branch)) {
				set.githubBranch = input.source.branch;
				if (repo) {
					await tx
						.update(githubRepos)
						.set({ deployBranch: input.source.branch })
						.where(eq(githubRepos.id, repo.id));
				}
			}
			const desiredRoot = input.source.rootDir;
			if (changed("source.rootDir", persisted.githubRootDir, desiredRoot)) {
				set.githubRootDir = desiredRoot;
			}
		}

		if (Object.keys(set).length > 0) {
			await tx.update(services).set(set).where(eq(services.id, service.id));
		}
		if (input.ports) {
			const currentPorts = ports
				.map((port) => [port.port, port.isPublic, port.domain] as const)
				.toSorted(
					(a, b) =>
						a[0] - b[0] ||
						Number(a[1]) - Number(b[1]) ||
						(a[2] ?? "").localeCompare(b[2] ?? ""),
				);
			const desiredPorts = input.ports
				.map(
					(port) =>
						[port.containerPort, port.public, port.domain ?? null] as const,
				)
				.toSorted(
					(a, b) =>
						a[0] - b[0] ||
						Number(a[1]) - Number(b[1]) ||
						(a[2] ?? "").localeCompare(b[2] ?? ""),
				);
			if (changed("ports", currentPorts, desiredPorts)) {
				await tx
					.delete(servicePorts)
					.where(eq(servicePorts.serviceId, service.id));
				if (input.ports.length > 0) {
					try {
						await tx.insert(servicePorts).values(
							input.ports.map((port) => ({
								id: randomUUID(),
								serviceId: service.id,
								port: port.containerPort,
								isPublic: port.public,
								domain: port.public ? (port.domain ?? null) : null,
								protocol: "http" as const,
							})),
						);
					} catch (error) {
						if (
							(error as { code?: string; constraint?: string }).code ===
								"23505" &&
							(error as { constraint?: string }).constraint ===
								"service_ports_domain_unique"
						) {
							domainError("Port domain is already in use", "DOMAIN_CONFLICT");
						}
						throw error;
					}
				}
			}
		}
		const cronsByPath = new Map(crons.map((cron) => [cron.path, cron]));
		const appliedAt = new Date();
		for (const cron of input.crons) {
			const existing = cronsByPath.get(cron.path);
			if (!existing) {
				await tx.insert(serviceCrons).values({
					id: randomUUID(),
					serviceId: service.id,
					...cron,
					nextScheduledFor: nextOccurrenceAfter(cron.schedule, appliedAt),
				});
			} else if (existing.schedule !== cron.schedule) {
				await tx
					.update(serviceCrons)
					.set({
						schedule: cron.schedule,
						nextScheduledFor: nextOccurrenceAfter(cron.schedule, appliedAt),
					})
					.where(eq(serviceCrons.id, existing.id));
			}
		}
		if (input.crons.length === 0) {
			await tx
				.delete(serviceCrons)
				.where(eq(serviceCrons.serviceId, service.id));
		} else {
			await tx.delete(serviceCrons).where(
				and(
					eq(serviceCrons.serviceId, service.id),
					notInArray(
						serviceCrons.path,
						input.crons.map((cron) => cron.path),
					),
				),
			);
		}

		return { targetServiceName: persisted.name, ...plan };
	});
}
