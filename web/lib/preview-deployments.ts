import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { getSetting } from "@/db/queries";
import {
	builds,
	environments,
	githubRepos,
	secrets,
	servicePorts,
	serviceReplicas,
	serviceRevisions,
	services,
} from "@/db/schema";
import {
	createGitHubDeployment,
	findGitHubDeployment,
	updateGitHubDeploymentStatus,
	upsertGitHubPullRequestComment,
} from "@/lib/github";
import { resolveRegistryImageHost } from "@/lib/registry-reference";
import {
	getDefaultServiceHostname,
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

type PreviewDeploymentState =
	| "pending"
	| "in_progress"
	| "success"
	| "failure"
	| "inactive";

const previewStateLabels: Record<PreviewDeploymentState, string> = {
	pending: "⏳ Queued",
	in_progress: "🚧 Deploying",
	success: "✅ Ready",
	failure: "❌ Failed",
	inactive: "🗑️ Removed",
};

function escapeGitHubCommentText(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("@", "&#64;")
		.replace(/\s+/g, " ")
		.trim();
}

async function updatePreviewPullRequestComment(input: {
	installationId: number;
	repoFullName: string;
	baseServiceId: string;
	previewGitRef: string;
	serviceName: string;
	state: PreviewDeploymentState;
	description: string;
	previewUrl: string | null;
}) {
	const pullRequestNumber = pullRequestNumberFromMergeRef(input.previewGitRef);
	const content = [
		"### Preview deployment",
		"",
		`**Service:** <code>${escapeGitHubCommentText(input.serviceName)}</code>`,
		`**Status:** ${previewStateLabels[input.state]}`,
		input.previewUrl
			? `**Preview:** [Open preview](${input.previewUrl})`
			: "**Preview:** No public URL configured",
		...(input.state === "failure"
			? [
					"",
					`<sub>${escapeGitHubCommentText(input.description.substring(0, 500))}</sub>`,
				]
			: []),
	].join("\n");
	await upsertGitHubPullRequestComment(
		input.installationId,
		input.repoFullName,
		pullRequestNumber,
		`<!-- techulus-preview:${input.baseServiceId} -->`,
		content,
	);
}

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

export async function getPreviewDomain() {
	const domain = await getSetting<string>(SETTING_KEYS.AUTO_SUBDOMAIN_DOMAIN);
	return domain?.trim().toLowerCase().replace(/\.$/, "") || null;
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
	domain: string | null;
}) {
	let publicHttpIndex = 0;
	return input.ports.map((port) => {
		if (port.isPublic && port.protocol === "http" && input.domain) {
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

export async function createPreviewClone(input: {
	baseServiceId: string;
	previewGitRef: string;
}) {
	const domain = await getPreviewDomain();
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
				.select()
				.from(serviceReplicas)
				.where(eq(serviceReplicas.serviceId, base.id))
				.orderBy(serviceReplicas.serverId),
		]);
		if (!repo) {
			throw new Error("Preview deployments require a GitHub App service");
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

		const serviceValues = {
			projectId: base.projectId,
			environmentId: previewEnvironment.id,
			name: `${base.name} (PR #${pullRequestNumber})`,
			hostname:
				primaryDomain?.split(".")[0] ??
				getDefaultServiceHostname(
					`${base.name}-pr-${pullRequestNumber}`,
					previewServiceId,
				),
			image: `${resolveRegistryImageHost()}/${base.projectId}/${previewServiceId}:latest`,
			sourceType: "github" as const,
			githubRepoUrl: base.githubRepoUrl,
			githubBranch: base.githubBranch,
			githubRootDir: base.githubRootDir,
			replicas: base.replicas,
			autoscalingEnabled: base.autoscalingEnabled,
			autoscalingMinReplicas: base.autoscalingMinReplicas,
			autoscalingMaxReplicas: base.autoscalingMaxReplicas,
			placementMode: base.placementMode,
			stateful: false,
			lockedServerId: base.lockedServerId,
			healthCheckCmd: base.healthCheckCmd,
			healthCheckInterval: base.healthCheckInterval,
			healthCheckTimeout: base.healthCheckTimeout,
			healthCheckRetries: base.healthCheckRetries,
			healthCheckStartPeriod: base.healthCheckStartPeriod,
			startCommand: base.startCommand,
			resourceCpuLimit: base.resourceCpuLimit,
			resourceMemoryLimitMb: base.resourceMemoryLimitMb,
			serverlessEnabled: base.serverlessEnabled && primaryDomain !== undefined,
			serverlessSleepAfterSeconds: base.serverlessSleepAfterSeconds,
			serverlessWakeTimeoutSeconds: base.serverlessWakeTimeoutSeconds,
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
				...port,
				id: randomUUID(),
				serviceId: previewServiceId,
			})),
		);
		if (base.placementMode === "manual" && placements.length > 0) {
			await tx.insert(serviceReplicas).values(
				placements.map((placement) => ({
					id: randomUUID(),
					serviceId: previewServiceId,
					serverId: placement.serverId,
					count: placement.count,
				})),
			);
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
			primaryUrl: primaryDomain ? `https://${primaryDomain}` : null,
		};
	});
}

export async function canDeployServiceRevision(
	serviceId: string,
	serviceRevisionId: string,
) {
	return db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${serviceId}))`);
		const service = await tx
			.select({ previewOfService: services.previewOfService })
			.from(services)
			.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
			.then((rows) => rows[0]);
		if (!service) return false;
		if (!service.previewOfService) return true;
		const latest = await tx
			.select({ id: serviceRevisions.id })
			.from(serviceRevisions)
			.where(eq(serviceRevisions.serviceId, serviceId))
			.orderBy(desc(serviceRevisions.createdAt), desc(serviceRevisions.id))
			.limit(1)
			.then((rows) => rows[0]);
		return latest?.id === serviceRevisionId;
	});
}

export async function updatePreviewGitHubStatus(input: {
	serviceId: string;
	serviceRevisionId: string;
	state: PreviewDeploymentState;
	description: string;
	logUrl?: string;
	expectedDeploymentId?: number;
}) {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${input.serviceId}))`,
		);
		const service = await tx
			.select({
				name: services.name,
				previewOfService: services.previewOfService,
				previewGitRef: services.previewGitRef,
			})
			.from(services)
			.where(and(eq(services.id, input.serviceId), isNull(services.deletedAt)))
			.then((rows) => rows[0]);
		if (!service?.previewOfService || !service.previewGitRef) return null;
		const latest = await tx
			.select({ id: serviceRevisions.id })
			.from(serviceRevisions)
			.where(eq(serviceRevisions.serviceId, input.serviceId))
			.orderBy(desc(serviceRevisions.createdAt), desc(serviceRevisions.id))
			.limit(1)
			.then((rows) => rows[0]);
		if (latest?.id !== input.serviceRevisionId) return null;
		const deploymentConditions = [
			eq(builds.serviceId, input.serviceId),
			eq(builds.serviceRevisionId, input.serviceRevisionId),
			isNotNull(builds.githubDeploymentId),
		];
		if (input.expectedDeploymentId !== undefined) {
			deploymentConditions.push(
				eq(builds.githubDeploymentId, input.expectedDeploymentId),
			);
		}
		const [deployment, githubRepo] = await Promise.all([
			tx
				.select({ id: builds.githubDeploymentId })
				.from(builds)
				.where(and(...deploymentConditions))
				.orderBy(desc(builds.createdAt), desc(builds.id))
				.limit(1)
				.then((rows) => rows[0]),
			tx
				.select({
					installationId: githubRepos.installationId,
					repoFullName: githubRepos.repoFullName,
				})
				.from(githubRepos)
				.where(eq(githubRepos.serviceId, service.previewOfService))
				.then((rows) => rows[0]),
		]);
		if (!deployment?.id || !githubRepo) return null;
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
		const previewUrl = primary?.domain ? `https://${primary.domain}` : null;
		await updateGitHubDeploymentStatus(
			githubRepo.installationId,
			githubRepo.repoFullName,
			deployment.id,
			input.state,
			{
				description: input.description.substring(0, 140),
				logUrl: input.logUrl,
				environmentUrl: previewUrl ?? undefined,
			},
		);
		await updatePreviewPullRequestComment({
			installationId: githubRepo.installationId,
			repoFullName: githubRepo.repoFullName,
			baseServiceId: service.previewOfService,
			previewGitRef: service.previewGitRef,
			serviceName: service.name,
			state: input.state,
			description: input.description,
			previewUrl,
		});
		return true;
	});
}

export async function createPreviewGitHubDeployment(input: {
	serviceId: string;
	serviceRevisionId: string;
	commitSha: string;
}) {
	const preview = await db
		.select({
			previewOfService: services.previewOfService,
			previewGitRef: services.previewGitRef,
		})
		.from(services)
		.where(and(eq(services.id, input.serviceId), isNull(services.deletedAt)))
		.then((rows) => rows[0]);
	if (!preview?.previewOfService || !preview.previewGitRef) return null;
	const existing = await db
		.select({ id: builds.githubDeploymentId })
		.from(builds)
		.where(
			and(
				eq(builds.serviceId, input.serviceId),
				eq(builds.serviceRevisionId, input.serviceRevisionId),
				isNotNull(builds.githubDeploymentId),
			),
		)
		.limit(1)
		.then((rows) => rows[0]?.id ?? null);
	if (existing) return existing;
	const githubRepo = await db
		.select()
		.from(githubRepos)
		.where(eq(githubRepos.serviceId, preview.previewOfService))
		.then((rows) => rows[0]);
	if (!githubRepo) return null;
	const pullRequestNumber = pullRequestNumberFromMergeRef(
		preview.previewGitRef,
	);
	const environment = `preview/pr-${pullRequestNumber}-${preview.previewOfService.slice(0, 8)}`;
	const payload = {
		baseServiceId: preview.previewOfService,
		previewServiceId: input.serviceId,
		previewGitRef: preview.previewGitRef,
		serviceRevisionId: input.serviceRevisionId,
	};
	const deploymentId =
		(await findGitHubDeployment(
			githubRepo.installationId,
			githubRepo.repoFullName,
			input.commitSha,
			environment,
			payload,
		)) ??
		(await createGitHubDeployment(
			githubRepo.installationId,
			githubRepo.repoFullName,
			input.commitSha,
			environment,
			`Preview PR #${pullRequestNumber}`,
			{
				transientEnvironment: true,
				productionEnvironment: false,
				payload,
			},
		));
	const updated = await db
		.update(builds)
		.set({ githubDeploymentId: deploymentId })
		.where(
			and(
				eq(builds.serviceId, input.serviceId),
				eq(builds.serviceRevisionId, input.serviceRevisionId),
				isNull(builds.githubDeploymentId),
			),
		)
		.returning({ id: builds.id });
	const current =
		updated.length > 0 &&
		(await updatePreviewGitHubStatus({
			serviceId: input.serviceId,
			serviceRevisionId: input.serviceRevisionId,
			expectedDeploymentId: deploymentId,
			state: "pending",
			description: "Preview build queued",
		}));
	if (!current) {
		await updateGitHubDeploymentStatus(
			githubRepo.installationId,
			githubRepo.repoFullName,
			deploymentId,
			"inactive",
			{ description: "Preview was superseded or removed" },
		);
	}
	return deploymentId;
}

export async function inactivatePreviewGitHubDeployments(input: {
	serviceId: string;
	description: string;
	excludeServiceRevisionId?: string;
}) {
	const service = await db
		.select({
			name: services.name,
			previewOfService: services.previewOfService,
			previewGitRef: services.previewGitRef,
		})
		.from(services)
		.where(eq(services.id, input.serviceId))
		.then((rows) => rows[0]);
	if (!service?.previewOfService) return 0;
	const githubRepo = await db
		.select()
		.from(githubRepos)
		.where(eq(githubRepos.serviceId, service.previewOfService))
		.then((rows) => rows[0]);
	if (!githubRepo) return 0;
	const conditions = [
		eq(builds.serviceId, input.serviceId),
		isNotNull(builds.githubDeploymentId),
	];
	if (input.excludeServiceRevisionId) {
		conditions.push(
			ne(builds.serviceRevisionId, input.excludeServiceRevisionId),
		);
	}
	const [deploymentIds, primary] = await Promise.all([
		db
			.selectDistinct({ id: builds.githubDeploymentId })
			.from(builds)
			.where(and(...conditions)),
		db
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
			),
	]);
	await Promise.all(
		deploymentIds.flatMap(({ id }) =>
			id
				? [
						updateGitHubDeploymentStatus(
							githubRepo.installationId,
							githubRepo.repoFullName,
							id,
							"inactive",
							{ description: input.description.substring(0, 140) },
						),
					]
				: [],
		),
	);
	if (!input.excludeServiceRevisionId && service.previewGitRef) {
		await updatePreviewPullRequestComment({
			installationId: githubRepo.installationId,
			repoFullName: githubRepo.repoFullName,
			baseServiceId: service.previewOfService,
			previewGitRef: service.previewGitRef,
			serviceName: service.name,
			state: "inactive",
			description: input.description,
			previewUrl: primary?.domain ? `https://${primary.domain}` : null,
		});
	}
	return deploymentIds.length;
}
