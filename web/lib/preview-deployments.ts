import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { getSetting } from "@/db/queries";
import {
	environments,
	githubRepos,
	secrets,
	servers,
	servicePorts,
	serviceReplicas,
	services,
} from "@/db/schema";
import { updateGitHubDeploymentStatus } from "@/lib/github";
import { resolveRegistryImageHost } from "@/lib/registry-reference";
import {
	pullRequestMergeRef,
	pullRequestNumberFromMergeRef,
} from "@/lib/service-revision-spec";
import { SETTING_KEYS } from "@/lib/settings-keys";

const DNS_LABEL_MAX_LENGTH = 63;
export const PREVIEWS_ENVIRONMENT_NAME = "previews";

type PreviewTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type PreviewPort = {
	port: number;
	isPublic: boolean;
	domain: string | null;
	protocol: "http" | "tcp" | "udp";
	externalPort: number | null;
	tlsPassthrough: boolean;
};

function dnsLabelPart(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
}

export function previewHostname(input: {
	serviceName: string;
	serviceId: string;
	pullRequestNumber: number;
	domain: string;
	portIndex?: number;
}) {
	if (
		!Number.isInteger(input.pullRequestNumber) ||
		input.pullRequestNumber < 1
	) {
		throw new Error("Invalid pull request number");
	}

	const service = dnsLabelPart(input.serviceName) || "service";
	const serviceId = dnsLabelPart(input.serviceId)
		.replaceAll("-", "")
		.slice(0, 8);
	if (!serviceId) throw new Error("Invalid service id");

	const portSuffix = input.portIndex ? `-p${input.portIndex + 1}` : "";
	const stableSuffix = `-pr-${input.pullRequestNumber}-${serviceId}${portSuffix}`;
	const availableServiceLength = DNS_LABEL_MAX_LENGTH - stableSuffix.length;
	if (availableServiceLength < 1) {
		throw new Error("Preview hostname suffix exceeds DNS label limit");
	}

	const label = `${service.slice(0, availableServiceLength).replace(/-+$/, "") || "s"}${stableSuffix}`;
	const domain = input.domain.trim().toLowerCase().replace(/\.$/, "");
	if (!domain) throw new Error("Automatic Subdomain Domain is not configured");

	return `${label}.${domain}`;
}

export async function requirePreviewDomain() {
	const domain = await getSetting<string>(SETTING_KEYS.AUTO_SUBDOMAIN_DOMAIN);
	const normalized = domain?.trim().toLowerCase().replace(/\.$/, "");
	if (!normalized) {
		throw new Error(
			"Automatic Subdomain Domain must be configured before enabling preview deployments",
		);
	}
	return normalized;
}

async function ensurePreviewEnvironmentInTransaction(
	tx: PreviewTransaction,
	projectId: string,
) {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtext(${`preview-environment:${projectId}`}))`,
	);
	const existing = await tx
		.select()
		.from(environments)
		.where(
			and(
				eq(environments.projectId, projectId),
				eq(environments.name, PREVIEWS_ENVIRONMENT_NAME),
			),
		)
		.then((rows) => rows[0]);
	if (existing) return existing;

	const created = await tx
		.insert(environments)
		.values({
			id: randomUUID(),
			projectId,
			name: PREVIEWS_ENVIRONMENT_NAME,
		})
		.onConflictDoNothing({
			target: [environments.projectId, environments.name],
		})
		.returning()
		.then((rows) => rows[0]);
	if (created) return created;

	const concurrent = await tx
		.select()
		.from(environments)
		.where(
			and(
				eq(environments.projectId, projectId),
				eq(environments.name, PREVIEWS_ENVIRONMENT_NAME),
			),
		)
		.then((rows) => rows[0]);
	if (!concurrent) throw new Error("Failed to create previews environment");
	return concurrent;
}

export async function ensurePreviewEnvironment(projectId: string) {
	return db.transaction((tx) =>
		ensurePreviewEnvironmentInTransaction(tx, projectId),
	);
}

export function previewPortConfiguration(input: {
	ports: PreviewPort[];
	serviceName: string;
	serviceId: string;
	pullRequestNumber: number;
	domain: string;
}) {
	let publicHttpIndex = 0;
	return input.ports.map((port) => {
		if (port.isPublic && port.protocol === "http") {
			const index = publicHttpIndex++;
			return {
				...port,
				domain: previewHostname({
					serviceName: input.serviceName,
					serviceId: input.serviceId,
					pullRequestNumber: input.pullRequestNumber,
					domain: input.domain,
					portIndex: index,
				}),
				externalPort: null,
				tlsPassthrough: false,
			};
		}
		return {
			...port,
			isPublic: false,
			domain: null,
			externalPort: null,
			tlsPassthrough: false,
		};
	});
}

export async function getPreviewClone(
	baseServiceId: string,
	previewGitRef: string,
) {
	pullRequestNumberFromMergeRef(previewGitRef);
	return db
		.select()
		.from(services)
		.where(
			and(
				eq(services.previewOfService, baseServiceId),
				eq(services.previewGitRef, previewGitRef),
				isNull(services.deletedAt),
			),
		)
		.then((rows) => rows[0] ?? null);
}

export async function createPreviewClone(input: {
	baseServiceId: string;
	previewGitRef: string;
}) {
	const domain = await requirePreviewDomain();
	const pullRequestNumber = pullRequestNumberFromMergeRef(input.previewGitRef);
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${input.baseServiceId}))`,
		);
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${input.baseServiceId}), hashtext(${input.previewGitRef}))`,
		);

		const base = await tx
			.select()
			.from(services)
			.where(
				and(
					eq(services.id, input.baseServiceId),
					isNull(services.previewOfService),
					isNull(services.deletedAt),
				),
			)
			.then((rows) => rows[0]);
		if (!base || !base.previewDeploymentsEnabled) {
			throw new Error("Preview deployments are not enabled for this service");
		}
		if (base.stateful) {
			throw new Error("Preview deployments require a stateless service");
		}
		if (base.sourceType !== "github") {
			throw new Error("Preview deployments require a GitHub App service");
		}

		const existing = await tx
			.select()
			.from(services)
			.where(
				and(
					eq(services.previewOfService, base.id),
					eq(services.previewGitRef, input.previewGitRef),
					isNull(services.deletedAt),
				),
			)
			.then((rows) => rows[0]);
		if (existing) {
			const primaryDomain = await tx
				.select({ domain: servicePorts.domain })
				.from(servicePorts)
				.where(
					and(
						eq(servicePorts.serviceId, existing.id),
						eq(servicePorts.protocol, "http"),
						eq(servicePorts.isPublic, true),
					),
				)
				.orderBy(servicePorts.port, servicePorts.id)
				.then((rows) => rows.find((row) => row.domain)?.domain ?? null);
			return {
				serviceId: existing.id,
				created: false,
				primaryUrl: primaryDomain ? `https://${primaryDomain}` : null,
			};
		}

		const [repo, ports, sourceSecrets, placements] = await Promise.all([
			tx
				.select()
				.from(githubRepos)
				.where(eq(githubRepos.serviceId, base.id))
				.then((rows) => rows[0]),
			tx
				.select()
				.from(servicePorts)
				.where(eq(servicePorts.serviceId, base.id))
				.orderBy(servicePorts.port, servicePorts.protocol, servicePorts.id),
			tx
				.select()
				.from(secrets)
				.where(eq(secrets.serviceId, base.id))
				.orderBy(secrets.key, secrets.id),
			tx
				.select({
					serverId: serviceReplicas.serverId,
					count: serviceReplicas.count,
					status: servers.status,
					wireguardIp: servers.wireguardIp,
				})
				.from(serviceReplicas)
				.innerJoin(servers, eq(serviceReplicas.serverId, servers.id))
				.where(eq(serviceReplicas.serviceId, base.id))
				.orderBy(serviceReplicas.serverId),
		]);
		if (!repo) {
			throw new Error("Preview deployments require a GitHub App service");
		}

		const publicHttpPorts = ports.filter(
			(port) => port.isPublic && port.protocol === "http",
		);
		if (publicHttpPorts.length === 0) {
			throw new Error(
				"Preview deployments require at least one public HTTP port",
			);
		}

		const eligiblePlacement = placements.find(
			(placement) =>
				placement.count > 0 &&
				placement.status === "online" &&
				placement.wireguardIp,
		);
		if (base.placementMode === "manual" && !eligiblePlacement) {
			throw new Error("No eligible placement exists for this preview");
		}

		const previewEnvironment = await ensurePreviewEnvironmentInTransaction(
			tx,
			base.projectId,
		);
		const previewServiceId = randomUUID();
		const configuredPorts = previewPortConfiguration({
			ports,
			serviceName: base.name,
			serviceId: base.id,
			pullRequestNumber,
			domain,
		});
		const primaryDomain = configuredPorts.find(
			(port) => port.isPublic && port.protocol === "http",
		)?.domain;
		if (!primaryDomain)
			throw new Error("Preview domain could not be generated");

		const serviceValues = {
			projectId: base.projectId,
			environmentId: previewEnvironment.id,
			name: `${base.name} (PR #${pullRequestNumber})`,
			hostname: primaryDomain.split(".")[0],
			image: `${resolveRegistryImageHost()}/${base.projectId}/${previewServiceId}:latest`,
			sourceType: "github" as const,
			githubRepoUrl: base.githubRepoUrl,
			githubBranch: base.githubBranch,
			githubRootDir: base.githubRootDir,
			replicas: 1,
			autoscalingEnabled: false,
			autoscalingMinReplicas: 1,
			autoscalingMaxReplicas: 1,
			placementMode: base.placementMode,
			stateful: false,
			lockedServerId: null,
			healthCheckCmd: base.healthCheckCmd,
			healthCheckInterval: base.healthCheckInterval,
			healthCheckTimeout: base.healthCheckTimeout,
			healthCheckRetries: base.healthCheckRetries,
			healthCheckStartPeriod: base.healthCheckStartPeriod,
			startCommand: base.startCommand,
			resourceCpuLimit: base.resourceCpuLimit,
			resourceMemoryLimitMb: base.resourceMemoryLimitMb,
			serverlessEnabled: false,
			deploymentSchedule: null,
			backupEnabled: false,
			backupSchedule: null,
			previewDeploymentsEnabled: false,
			previewOfService: base.id,
			previewGitRef: pullRequestMergeRef(pullRequestNumber),
		};

		await tx.insert(services).values({
			id: previewServiceId,
			...serviceValues,
		});
		await tx.insert(servicePorts).values(
			configuredPorts.map((port) => ({
				id: randomUUID(),
				serviceId: previewServiceId,
				...port,
			})),
		);
		if (base.placementMode === "manual" && eligiblePlacement) {
			await tx.insert(serviceReplicas).values({
				id: randomUUID(),
				serviceId: previewServiceId,
				serverId: eligiblePlacement.serverId,
				count: 1,
			});
		}
		if (sourceSecrets.length > 0) {
			await tx.insert(secrets).values(
				sourceSecrets.map((secret) => ({
					id: randomUUID(),
					serviceId: previewServiceId,
					key: secret.key,
					encryptedValue: secret.encryptedValue,
					updatedAt: secret.updatedAt,
				})),
			);
		}
		await tx.insert(githubRepos).values({
			id: randomUUID(),
			installationId: repo.installationId,
			repoId: repo.repoId,
			repoFullName: repo.repoFullName,
			defaultBranch: repo.defaultBranch,
			serviceId: previewServiceId,
			deployBranch: repo.deployBranch,
			autoDeploy: false,
		});

		return {
			serviceId: previewServiceId,
			created: true,
			primaryUrl: `https://${primaryDomain}`,
		};
	});
}

export async function canDeployServiceRevision(
	serviceId: string,
	serviceRevisionId: string,
) {
	const service = await db
		.select({
			previewOfService: services.previewOfService,
			previewCurrentRevisionId: services.previewCurrentRevisionId,
		})
		.from(services)
		.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
		.then((rows) => rows[0]);
	if (!service) return false;
	return (
		!service.previewOfService ||
		service.previewCurrentRevisionId === serviceRevisionId
	);
}

export async function getPreviewPrimaryUrl(serviceId: string) {
	const ports = await db
		.select({
			id: servicePorts.id,
			port: servicePorts.port,
			domain: servicePorts.domain,
		})
		.from(servicePorts)
		.where(
			and(
				eq(servicePorts.serviceId, serviceId),
				eq(servicePorts.protocol, "http"),
				eq(servicePorts.isPublic, true),
			),
		);
	const primary = ports
		.filter((port) => port.domain)
		.sort((a, b) => a.port - b.port || a.id.localeCompare(b.id))[0];
	return primary?.domain ? `https://${primary.domain}` : null;
}

export async function updateCurrentPreviewGitHubStatus(input: {
	serviceId: string;
	serviceRevisionId: string | null;
	state: "pending" | "in_progress" | "success" | "failure" | "inactive";
	description: string;
	logUrl?: string;
	expectedDeploymentId?: number;
}) {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${input.serviceId}))`,
		);
		const context = await tx
			.select({
				previewCurrentRevisionId: services.previewCurrentRevisionId,
				previewGithubDeploymentId: services.previewGithubDeploymentId,
				previewOfService: services.previewOfService,
				installationId: githubRepos.installationId,
				repoFullName: githubRepos.repoFullName,
			})
			.from(services)
			.innerJoin(
				githubRepos,
				eq(githubRepos.serviceId, services.previewOfService),
			)
			.where(and(eq(services.id, input.serviceId), isNull(services.deletedAt)))
			.then((rows) => rows[0]);
		if (
			!context?.previewOfService ||
			context.previewCurrentRevisionId !== input.serviceRevisionId ||
			!context.previewGithubDeploymentId ||
			(input.expectedDeploymentId !== undefined &&
				context.previewGithubDeploymentId !== input.expectedDeploymentId)
		) {
			return false;
		}
		const primary = await tx
			.select({
				id: servicePorts.id,
				port: servicePorts.port,
				domain: servicePorts.domain,
			})
			.from(servicePorts)
			.where(
				and(
					eq(servicePorts.serviceId, input.serviceId),
					eq(servicePorts.protocol, "http"),
					eq(servicePorts.isPublic, true),
				),
			)
			.then(
				(ports) =>
					ports
						.filter((port) => port.domain)
						.sort((a, b) => a.port - b.port || a.id.localeCompare(b.id))[0],
			);
		await updateGitHubDeploymentStatus(
			context.installationId,
			context.repoFullName,
			context.previewGithubDeploymentId,
			input.state,
			{
				description: input.description.substring(0, 140),
				logUrl: input.logUrl,
				environmentUrl: primary?.domain
					? `https://${primary.domain}`
					: undefined,
			},
		);
		return true;
	});
}
