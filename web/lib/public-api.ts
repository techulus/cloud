import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
	deployments,
	environments,
	githubRepos,
	projects,
	servers,
	servicePorts,
	serviceReplicas,
	serviceRevisions,
	services,
	serviceVolumes,
} from "@/db/schema";
import { validateDockerImageInternal } from "@/lib/docker-image";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";
import { getDefaultServiceHostname } from "@/lib/service-revision-spec";

const githubPathPart = /^[A-Za-z0-9_.-]+$/;
const windowsAbsolutePath = /^[A-Za-z]:[\\/]/;

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
		rootDir: rootDirSchema.nullable().optional(),
	}),
]);

export type PublicSource =
	| { type: "image"; image: string }
	| {
			type: "github";
			repository: string | null;
			branch: string;
			rootDir?: string;
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
		...(service.githubRootDir?.trim()
			? { rootDir: service.githubRootDir.trim() }
			: {}),
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

export async function findNestedService(
	projectId: string,
	environmentId: string,
	serviceId: string,
) {
	const row = await db
		.select({ service: services })
		.from(projects)
		.innerJoin(
			environments,
			and(
				eq(environments.id, environmentId),
				eq(environments.projectId, projects.id),
			),
		)
		.innerJoin(
			services,
			and(
				eq(services.id, serviceId),
				eq(services.projectId, projects.id),
				eq(services.environmentId, environments.id),
				isNull(services.deletedAt),
			),
		)
		.where(eq(projects.id, projectId))
		.limit(1);
	return row[0]?.service ?? null;
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
	replicaCount: number;
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
	if (input.replicaCount < 1 || input.replicaCount > 10) {
		blockers.push({
			code: "INVALID_PLACEMENT",
			message: "Manual placement must contain between 1 and 10 replicas",
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
	return {
		source:
			spec.source.type === "github"
				? {
						type: "github" as const,
						repository: spec.source.repository,
						branch: spec.source.branch,
						...(spec.source.rootDir
							? { rootDir: spec.source.rootDir }
							: {}),
					}
				: { type: "image" as const, image: spec.source.image },
		hostname: spec.hostname,
		stateful: spec.stateful,
		replicas: spec.placements.reduce(
			(sum, placement) => sum + placement.count,
			0,
		),
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
	const [repo, ports, volumes, placements, activeDeployment] =
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
	const replicaCount = sortedPlacements.reduce(
		(sum, placement) => sum + placement.count,
		0,
	);
	const current = {
		source,
		hostname: service.hostname,
		stateful: service.stateful,
		replicas: replicaCount,
		placements: sortedPlacements,
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
		hostname:
			current.hostname?.trim() || getDefaultServiceHostname(service.name),
		stateful: current.stateful,
		replicas: current.replicas,
		placements: current.placements.map(({ serverId, count }) => ({
			serverId,
			count,
		})),
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
		replicaCount,
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
export const configurationPatchSchema = z.strictObject({
	source: publicSourceSchema.optional(),
	hostname: hostnameSchema.nullable().optional(),
	ports: z.array(portSchema).max(100).optional(),
	replicas: z.number().int().min(1).max(10).optional(),
	healthCheck: healthCheckSchema.nullable().optional(),
	startCommand: z.string().trim().min(1).max(4096).nullable().optional(),
	resources: z
		.strictObject({
			cpuCores: z.number().min(0.1).max(64).nullable(),
			memoryMb: z.number().int().min(64).max(65536).nullable(),
		})
		.refine(
			(value) => (value.cpuCores === null) === (value.memoryMb === null),
			"CPU and memory limits must both be set or both be null",
		)
		.optional(),
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

export async function patchConfiguration(
	service: NestedService,
	input: z.infer<typeof configurationPatchSchema>,
) {
	if (input.source?.type === "image" && input.source.image !== service.image) {
		const validation = await validateDockerImageInternal(input.source.image);
		if (!validation.valid) {
			domainError(validation.error || "Invalid image", "INVALID_IMAGE", 400);
		}
	}

	return db.transaction(async (tx) => {
		const persisted = await tx
			.select()
			.from(services)
			.where(and(eq(services.id, service.id), isNull(services.deletedAt)))
			.limit(1)
			.then((rows) => rows[0]);
		if (!persisted) domainError("Service not found", "NOT_FOUND", 404);

		const [ports, volumes, placements, repo] = await Promise.all([
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
		]);
		const replicaCount = placements.reduce(
			(sum, placement) => sum + placement.count,
			0,
		);
		const source = resolvePersistedSourceFromRows(persisted, repo);
		const blockers = getManagementBlockers({
			service: persisted,
			source,
			ports,
			volumeCount: volumes.length,
			replicaCount,
		});
		if (blockers[0]) {
			domainError(blockers[0].message, blockers[0].code);
		}

		if (input.source && input.source.type !== persisted.sourceType) {
			domainError(
				"Source type conversion is not supported; change the source in the web UI",
				"SOURCE_TYPE_CONVERSION",
			);
		}
		if (input.source?.type === "github") {
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
		if (input.replicas !== undefined && input.replicas !== replicaCount) {
			domainError(
				`replicas must match the current manual placement of ${replicaCount}`,
				"REPLICA_PLACEMENT_MISMATCH",
			);
		}

		if (input.hostname) {
			const duplicate = await tx
				.select({ id: services.id })
				.from(services)
				.where(
					and(
						eq(services.hostname, input.hostname),
						ne(services.id, service.id),
					),
				)
				.limit(1)
				.then((rows) => rows[0]);
			if (duplicate) {
				domainError("Hostname is already in use", "HOSTNAME_CONFLICT");
			}
		}
		if (input.ports) {
			if (
				persisted.serverlessEnabled &&
				!input.ports.some((port) => port.public && port.domain)
			) {
				domainError(
					"Serverless services require a public HTTP port with a domain",
					"SERVERLESS_PORT_REQUIRED",
					400,
				);
			}
			if (
				new Set(input.ports.map((port) => port.containerPort)).size !==
				input.ports.length
			) {
				domainError("Port numbers must be unique", "DUPLICATE_PORT", 400);
			}
			const domains = input.ports.flatMap((port) =>
				port.public && port.domain ? [port.domain] : [],
			);
			if (new Set(domains).size !== domains.length) {
				domainError("Port domains must be unique", "DUPLICATE_DOMAIN", 400);
			}
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
		}

		const changes: string[] = [];
		const set: Partial<NestedService> = {};
		const changed = (label: string, from: unknown, to: unknown) => {
			if (JSON.stringify(from) === JSON.stringify(to)) return false;
			changes.push(label);
			return true;
		};

		if (
			input.hostname !== undefined &&
			changed("hostname", persisted.hostname, input.hostname)
		) {
			set.hostname = input.hostname;
		}
		if (
			input.startCommand !== undefined &&
			changed("startCommand", persisted.startCommand, input.startCommand)
		) {
			set.startCommand = input.startCommand;
		}
		if (
			input.healthCheck !== undefined &&
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
			input.resources !== undefined &&
			changed(
				"resources",
				{
					cpuCores: persisted.resourceCpuLimit,
					memoryMb: persisted.resourceMemoryLimitMb,
				},
				input.resources,
			)
		) {
			set.resourceCpuLimit = input.resources.cpuCores;
			set.resourceMemoryLimitMb = input.resources.memoryMb;
		}
		if (
			input.source?.type === "image" &&
			changed("source.image", persisted.image, input.source.image)
		) {
			set.image = input.source.image;
		}
		if (input.source?.type === "github") {
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
			if (input.source.rootDir !== undefined) {
				const desiredRoot = input.source.rootDir;
				if (changed("source.rootDir", persisted.githubRootDir, desiredRoot)) {
					set.githubRootDir = desiredRoot;
				}
			}
		}

		if (Object.keys(set).length > 0) {
			await tx.update(services).set(set).where(eq(services.id, service.id));
		}
		if (input.ports) {
			const currentPorts = ports
				.map((port) => [port.port, port.isPublic, port.domain] as const)
				.toSorted((a, b) => a[0] - b[0]);
			const desiredPorts = input.ports
				.map(
					(port) =>
						[port.containerPort, port.public, port.domain ?? null] as const,
				)
				.toSorted((a, b) => a[0] - b[0]);
			if (changed("ports", currentPorts, desiredPorts)) {
				await tx
					.delete(servicePorts)
					.where(eq(servicePorts.serviceId, service.id));
				if (input.ports.length > 0) {
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
				}
			}
		}

		return {
			action: changes.length > 0 ? ("updated" as const) : ("noop" as const),
			changes,
		};
	});
}
