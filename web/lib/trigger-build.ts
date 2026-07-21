import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { githubRepos, services } from "@/db/schema";
import { resolveGitHubCommit } from "@/lib/github";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import {
	canonicalGitHubRepository,
	resolvePersistedSourceFromRows,
} from "@/lib/public-api";
import type { ServiceRevisionActor } from "@/lib/service-revision-actor";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";
import {
	cloneGitHubBuildServiceRevision,
	createGitHubBuildServiceRevision,
} from "@/lib/service-revisions";

type BuildTrigger = "manual" | "scheduled" | "push";
const fullCommitSha = /^[0-9a-f]{40}$/i;

type ResolvedBuildInput = {
	trigger: BuildTrigger;
	commitSha: string;
	commitMessage: string;
	author?: string;
	actor: ServiceRevisionActor;
	expectedRepository?: string;
	expectedBranch?: string;
	githubDeploymentId?: number;
	idempotencyKey?: string;
};

function deterministicRevisionId(key: string): string {
	const hash = createHash("sha256").update(key).digest("hex");
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function getGitHubBuildSource(serviceId: string) {
	const [service, repo] = await Promise.all([
		db
			.select()
			.from(services)
			.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
			.limit(1)
			.then((rows) => rows[0]),
		db
			.select()
			.from(githubRepos)
			.where(eq(githubRepos.serviceId, serviceId))
			.limit(1)
			.then((rows) => rows[0]),
	]);
	if (!service || service.sourceType !== "github") {
		throw new Error("Active GitHub service not found");
	}
	const source = resolvePersistedSourceFromRows(service, repo);
	if (source.type !== "github" || !source.repository) {
		throw new Error("No GitHub repository linked to this service");
	}
	return {
		service,
		repo,
		source: { ...source, repository: source.repository },
	};
}

async function sendBuildTrigger(
	data: Parameters<typeof inngestEvents.buildTrigger.create>[0],
	eventId?: string,
) {
	const event = eventId
		? inngestEvents.buildTrigger.create(data, { id: eventId })
		: inngestEvents.buildTrigger.create(data);
	await inngest.send(event);
}

export async function triggerResolvedBuildInternal(
	serviceId: string,
	input: ResolvedBuildInput,
) {
	if (!fullCommitSha.test(input.commitSha)) {
		throw new Error("Commit SHA must be a full 40-character hexadecimal SHA");
	}
	const sourceContext = await getGitHubBuildSource(serviceId);
	return queueResolvedBuild(serviceId, input, sourceContext);
}

async function queueResolvedBuild(
	serviceId: string,
	input: ResolvedBuildInput,
	{ service, source }: Awaited<ReturnType<typeof getGitHubBuildSource>>,
) {
	if (!fullCommitSha.test(input.commitSha)) {
		throw new Error("Commit SHA must be a full 40-character hexadecimal SHA");
	}
	const commitSha = input.commitSha.toLowerCase();
	const expectedRepository = input.expectedRepository
		? canonicalGitHubRepository(input.expectedRepository)
		: source.repository;
	const expectedBranch = input.expectedBranch ?? source.branch;
	if (
		source.repository !== expectedRepository ||
		source.branch !== expectedBranch
	) {
		throw new Error("GitHub source changed before the build was queued");
	}

	const registryHost = process.env.REGISTRY_HOST?.replace(/\/+$/, "");
	if (!registryHost) {
		throw new Error("REGISTRY_HOST environment variable is required");
	}
	const serviceRevisionId = input.idempotencyKey
		? deterministicRevisionId(input.idempotencyKey)
		: randomUUID();
	const image = `${registryHost}/${service.projectId}/${service.id}:revision-${serviceRevisionId}`;

	await createGitHubBuildServiceRevision({
		id: serviceRevisionId,
		serviceId,
		image,
		commitSha,
		expectedRepository,
		expectedBranch,
		actor: input.actor,
	});

	const buildRequestId = randomUUID();
	await sendBuildTrigger(
		{
			serviceId,
			serviceRevisionId,
			buildRequestId,
			trigger: input.trigger,
			commitSha,
			commitMessage: input.commitMessage.substring(0, 500),
			branch: expectedBranch,
			author: input.author,
			actor: input.actor,
			githubDeploymentId: input.githubDeploymentId,
		},
		input.idempotencyKey,
	);

	return { buildId: null, serviceRevisionId, status: "queued" as const };
}

export async function requeueBuildRevisionInternal(input: {
	serviceId: string;
	serviceRevisionId: string;
	commitMessage: string;
	author?: string;
	actor: ServiceRevisionActor;
}) {
	const revision = await cloneGitHubBuildServiceRevision({
		serviceId: input.serviceId,
		sourceRevisionId: input.serviceRevisionId,
		actor: input.actor,
	});
	const specification = parseServiceRevisionSpec(revision.specification);
	if (specification.source.type !== "github")
		throw new Error("Invalid retry revision");

	const buildRequestId = randomUUID();
	await sendBuildTrigger({
		serviceId: input.serviceId,
		serviceRevisionId: revision.id,
		buildRequestId,
		trigger: "manual",
		commitSha: specification.source.commitSha,
		commitMessage: input.commitMessage.substring(0, 500),
		branch: specification.source.branch,
		author: input.author,
		actor: input.actor,
	});
	return {
		status: "queued" as const,
		serviceRevisionId: revision.id,
		buildRequestId,
	};
}

export async function triggerBuildInternal(
	serviceId: string,
	trigger: "manual" | "scheduled",
	actor: ServiceRevisionActor,
) {
	const sourceContext = await getGitHubBuildSource(serviceId);
	const { repo, source } = sourceContext;
	const repoFullName =
		repo?.repoFullName ??
		new URL(source.repository).pathname.replace(/^\//, "");
	const commit = await resolveGitHubCommit(
		repoFullName,
		source.branch,
		repo?.installationId,
	);
	return queueResolvedBuild(
		serviceId,
		{
			trigger,
			commitSha: commit.sha,
			commitMessage: commit.message,
			author: commit.author ?? undefined,
			actor,
			expectedRepository: source.repository,
			expectedBranch: source.branch,
		},
		sourceContext,
	);
}
