import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { githubRepos, serviceRevisions, services } from "@/db/schema";
import {
	getGitHubPullRequest,
	listOpenGitHubPullRequests,
	resolveGitHubPullRequestMergeRef,
} from "@/lib/github";
import {
	createPreviewClone,
	inactivatePreviewGitHubDeployments,
} from "@/lib/preview-deployments";
import {
	cancelPreviewRevisionWork,
	deactivatePreviewRuntime,
	deletePreviewService,
} from "@/lib/preview-lifecycle";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";
import {
	pullRequestMergeRef,
	pullRequestNumberFromMergeRef,
} from "@/lib/service-revision-spec";
import { triggerResolvedBuildInternal } from "@/lib/trigger-build";
import { inngest } from "../client";
import { inngestEvents } from "../events";

async function loadBaseContext(baseServiceId: string) {
	return db
		.select({ service: services, githubRepo: githubRepos })
		.from(services)
		.innerJoin(githubRepos, eq(githubRepos.serviceId, services.id))
		.where(
			and(
				eq(services.id, baseServiceId),
				isNull(services.previewOfService),
				isNull(services.deletedAt),
			),
		)
		.then((rows) => rows[0]);
}

async function closePreview(
	baseServiceId: string,
	previewGitRef: string,
	reason: string,
) {
	const deleted = await deletePreviewService(
		baseServiceId,
		previewGitRef,
		reason,
	);
	return deleted
		? { status: "deleted" as const, serviceId: deleted.service.id }
		: { status: "not_found" as const };
}

function isEligiblePullRequest(
	context: {
		service: {
			previewDeploymentsEnabled: boolean;
			stateful: boolean;
			sourceType: "image" | "github";
		};
		githubRepo: {
			repoId: number;
			deployBranch: string | null;
			defaultBranch: string;
		};
	},
	pullRequest: Awaited<ReturnType<typeof getGitHubPullRequest>>,
) {
	return (
		context.service.previewDeploymentsEnabled &&
		!context.service.stateful &&
		context.service.sourceType === "github" &&
		pullRequest.state === "open" &&
		!pullRequest.draft &&
		pullRequest.base.repository.id === context.githubRepo.repoId &&
		pullRequest.head.repository?.id === context.githubRepo.repoId &&
		pullRequest.base.ref ===
			(context.githubRepo.deployBranch ?? context.githubRepo.defaultBranch)
	);
}

async function loadPreviewContext(
	baseServiceId: string,
	previewGitRef: string,
) {
	return db
		.select({ service: services, githubRepo: githubRepos })
		.from(services)
		.innerJoin(
			githubRepos,
			eq(githubRepos.serviceId, services.previewOfService),
		)
		.where(
			and(
				eq(services.previewOfService, baseServiceId),
				eq(services.previewGitRef, previewGitRef),
				isNull(services.deletedAt),
			),
		)
		.then((rows) => rows[0]);
}

async function closePreviewFromEvent(input: {
	baseServiceId: string;
	previewGitRef: string;
	reason: string;
	verifyWithGitHub?: boolean;
}) {
	const pullRequestNumber = pullRequestNumberFromMergeRef(input.previewGitRef);
	if (input.verifyWithGitHub) {
		const [baseContext, previewContext] = await Promise.all([
			loadBaseContext(input.baseServiceId),
			loadPreviewContext(input.baseServiceId, input.previewGitRef),
		]);
		if (!previewContext) return { status: "not_found" as const };
		if (baseContext) {
			const pullRequest = await getGitHubPullRequest(
				previewContext.githubRepo.installationId,
				previewContext.githubRepo.repoFullName,
				pullRequestNumber,
			);
			if (isEligiblePullRequest(baseContext, pullRequest)) {
				await enqueuePreviewSync(
					input.baseServiceId,
					input.previewGitRef,
					`stale-close:${pullRequest.updatedAt}`,
				);
				return { status: "stale" as const };
			}
		}
	}
	return closePreview(input.baseServiceId, input.previewGitRef, input.reason);
}

async function loadLatestPreviewRevision(serviceId: string) {
	const service = await db
		.select({ previewOfService: services.previewOfService })
		.from(services)
		.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
		.then((rows) => rows[0]);
	if (!service?.previewOfService) return null;
	const revision = await db
		.select({
			id: serviceRevisions.id,
			specification: serviceRevisions.specification,
		})
		.from(serviceRevisions)
		.where(eq(serviceRevisions.serviceId, serviceId))
		.orderBy(desc(serviceRevisions.createdAt), desc(serviceRevisions.id))
		.limit(1)
		.then((rows) => rows[0]);
	if (!revision) return null;
	const specification = parseServiceRevisionSpec(revision.specification);
	return {
		id: revision.id,
		commitSha:
			specification.source.type === "github"
				? specification.source.commitSha
				: null,
	};
}

export const previewSyncWorkflow = inngest.createFunction(
	{
		id: "preview-sync-workflow",
		triggers: [
			inngestEvents.previewSyncRequested,
			inngestEvents.previewCloseRequested,
		],
		concurrency: [
			{
				limit: 1,
				key: 'event.data.baseServiceId + ":" + event.data.previewGitRef',
			},
		],
	},
	async ({ event, step }) => {
		if (event.name === inngestEvents.previewCloseRequested.name) {
			return step.run("delete-preview", () =>
				closePreviewFromEvent(event.data),
			);
		}
		const { baseServiceId, previewGitRef } = event.data;
		const force = "force" in event.data && event.data.force === true;
		const pullRequestNumber = pullRequestNumberFromMergeRef(previewGitRef);
		const context = await step.run("load-base-service", () =>
			loadBaseContext(baseServiceId),
		);
		if (!context) {
			await step.run("close-orphaned-preview", () =>
				closePreview(baseServiceId, previewGitRef, "base service unavailable"),
			);
			return { status: "closed", reason: "base_service_unavailable" };
		}

		const pullRequest = await step.run("load-pull-request", () =>
			getGitHubPullRequest(
				context.githubRepo.installationId,
				context.githubRepo.repoFullName,
				pullRequestNumber,
			),
		);
		if (!isEligiblePullRequest(context, pullRequest)) {
			await step.run("close-ineligible-preview", () =>
				closePreview(baseServiceId, previewGitRef, "pull request ineligible"),
			);
			return { status: "closed", reason: "pull_request_ineligible" };
		}

		const clone = await step.run("create-preview-service", () =>
			createPreviewClone({
				baseServiceId,
				previewGitRef,
			}),
		);
		const previous = await step.run("load-latest-preview-revision", () =>
			loadLatestPreviewRevision(clone.serviceId),
		);
		let mergeRef: { gitRef: string; sha: string };
		try {
			mergeRef = await step.run("resolve-merge-ref", () =>
				resolveGitHubPullRequestMergeRef(
					context.githubRepo.installationId,
					context.githubRepo.repoFullName,
					pullRequestNumber,
				),
			);
		} catch {
			await step.run("deactivate-unmergeable-preview", () =>
				deactivatePreviewRuntime(clone.serviceId),
			);
			await step.run("inactivate-unmergeable-deployments", () =>
				inactivatePreviewGitHubDeployments({
					serviceId: clone.serviceId,
					description: "Preview merge ref is unavailable",
				}),
			);
			return { status: "failed", reason: "merge_ref_unavailable" };
		}

		if (!force && previous?.commitSha === mergeRef.sha) {
			return { status: "unchanged", serviceId: clone.serviceId };
		}

		const queued = await step.run("queue-preview-build", () =>
			triggerResolvedBuildInternal(clone.serviceId, {
				trigger: "preview",
				commitSha: mergeRef.sha,
				commitMessage: `Preview PR #${pullRequestNumber}: ${pullRequest.title}`,
				author: pullRequest.user.login,
				actor: {
					type: "github",
					githubUserId: pullRequest.user.id,
					login: pullRequest.user.login,
				},
				gitRef: mergeRef.gitRef,
				idempotencyKey: force
					? `preview:${clone.serviceId}:${mergeRef.sha}:${event.id}`
					: `preview:${clone.serviceId}:${mergeRef.sha}`,
			}),
		);
		if (previous) {
			await step.run("cancel-superseded-preview", () =>
				cancelPreviewRevisionWork(clone.serviceId, previous.id),
			);
		}
		await step.run("inactivate-superseded-deployments", () =>
			inactivatePreviewGitHubDeployments({
				serviceId: clone.serviceId,
				excludeServiceRevisionId: queued.serviceRevisionId,
				description: "Superseded by a newer preview revision",
			}),
		);
		return queued;
	},
);

export const previewServiceReconcileWorkflow = inngest.createFunction(
	{
		id: "preview-service-reconcile-workflow",
		triggers: [inngestEvents.previewServiceReconcileRequested],
		concurrency: [{ limit: 1, key: "event.data.baseServiceId" }],
	},
	async ({ event, step }) => {
		const context = await step.run("load-base-service", () =>
			loadBaseContext(event.data.baseServiceId),
		);
		if (!context || !context.service.previewDeploymentsEnabled) {
			const clones = await step.run("load-previews-to-close", () =>
				db
					.select({ previewGitRef: services.previewGitRef })
					.from(services)
					.where(eq(services.previewOfService, event.data.baseServiceId)),
			);
			await Promise.all(
				clones.flatMap((clone) =>
					clone.previewGitRef
						? [
								step.run(`close-disabled-${clone.previewGitRef}`, () =>
									closePreview(
										event.data.baseServiceId,
										clone.previewGitRef!,
										"preview deployments disabled",
									),
								),
							]
						: [],
				),
			);
			return { status: "disabled", closed: clones.length };
		}
		const pullRequests = await step.run("list-open-pull-requests", () =>
			listOpenGitHubPullRequests(
				context.githubRepo.installationId,
				context.githubRepo.repoFullName,
				context.githubRepo.deployBranch ?? context.githubRepo.defaultBranch,
			),
		);
		const eligible = pullRequests.filter((pullRequest) =>
			isEligiblePullRequest(context, pullRequest),
		);
		const eligibleRefs = new Set(
			eligible.map((pullRequest) => pullRequestMergeRef(pullRequest.number)),
		);
		const existing = await step.run("list-existing-previews", () =>
			db
				.select({
					previewGitRef: services.previewGitRef,
					deletedAt: services.deletedAt,
				})
				.from(services)
				.where(eq(services.previewOfService, event.data.baseServiceId)),
		);
		const deleting = existing.filter(
			(clone) => clone.previewGitRef && clone.deletedAt != null,
		);
		await Promise.all(
			deleting.map((clone) =>
				step.run(`finish-delete-${clone.previewGitRef}`, () =>
					closePreview(
						event.data.baseServiceId,
						clone.previewGitRef!,
						"retrying preview deletion",
					),
				),
			),
		);
		const stale = existing.filter(
			(clone) =>
				clone.previewGitRef &&
				clone.deletedAt == null &&
				!eligibleRefs.has(clone.previewGitRef),
		);
		await Promise.all(
			stale.map((clone) =>
				step.run(`queue-close-${clone.previewGitRef}`, () =>
					enqueuePreviewClose(
						event.data.baseServiceId,
						clone.previewGitRef!,
						"pull request no longer eligible",
						`reconcile:${event.id}`,
					),
				),
			),
		);
		await Promise.all(
			eligible.map((pullRequest) =>
				step.run(`queue-pr-${pullRequest.number}`, () =>
					enqueuePreviewSync(
						event.data.baseServiceId,
						pullRequestMergeRef(pullRequest.number),
						`reconcile:${pullRequest.updatedAt}`,
					),
				),
			),
		);
		return {
			status: "queued",
			count: eligible.length,
			closed: deleting.length + stale.length,
		};
	},
);

async function enqueuePreviewClose(
	baseServiceId: string,
	previewGitRef: string,
	reason: string,
	idSuffix: string,
) {
	const pullRequestNumber = pullRequestNumberFromMergeRef(previewGitRef);
	await inngest.send(
		inngestEvents.previewCloseRequested.create(
			{ baseServiceId, previewGitRef, reason, verifyWithGitHub: true },
			{
				id: `preview-close:${baseServiceId}:${pullRequestNumber}:${idSuffix}`,
			},
		),
	);
}

async function enqueuePreviewSync(
	baseServiceId: string,
	previewGitRef: string,
	idSuffix: string,
) {
	const pullRequestNumber = pullRequestNumberFromMergeRef(previewGitRef);
	await inngest.send(
		inngestEvents.previewSyncRequested.create(
			{ baseServiceId, previewGitRef },
			{
				id: `preview-reconcile:${baseServiceId}:${pullRequestNumber}:${idSuffix}`,
			},
		),
	);
}
