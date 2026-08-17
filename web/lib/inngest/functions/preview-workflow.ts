import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { githubRepos, serviceRevisions, services } from "@/db/schema";
import {
	createGitHubDeployment,
	getGitHubPullRequest,
	listOpenGitHubPullRequests,
	resolveGitHubPullRequestMergeRef,
	updateGitHubDeploymentStatus,
} from "@/lib/github";
import {
	createPreviewClone,
	updateCurrentPreviewGitHubStatus,
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

async function loadCurrentPreviewRevision(serviceId: string) {
	const service = await db
		.select({
			previewCurrentRevisionId: services.previewCurrentRevisionId,
			previewGithubDeploymentId: services.previewGithubDeploymentId,
		})
		.from(services)
		.where(eq(services.id, serviceId))
		.then((rows) => rows[0]);
	if (!service?.previewCurrentRevisionId) {
		return service ? { ...service, commitSha: null } : null;
	}
	const revision = await db
		.select({ specification: serviceRevisions.specification })
		.from(serviceRevisions)
		.where(eq(serviceRevisions.id, service.previewCurrentRevisionId))
		.then((rows) => rows[0]);
	if (!revision) return { ...service, commitSha: null };
	const specification = parseServiceRevisionSpec(revision.specification);
	return {
		...service,
		commitSha:
			specification.source.type === "github"
				? specification.source.commitSha
				: null,
	};
}

async function clearCurrentPreviewRevision(input: {
	baseServiceId: string;
	previewGitRef: string;
	previewServiceId: string;
}) {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${input.baseServiceId}))`,
		);
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${input.baseServiceId}), hashtext(${input.previewGitRef}))`,
		);
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${input.previewServiceId}))`,
		);
		const current = await tx
			.select({
				previewCurrentRevisionId: services.previewCurrentRevisionId,
				previewGithubDeploymentId: services.previewGithubDeploymentId,
			})
			.from(services)
			.where(
				and(
					eq(services.id, input.previewServiceId),
					eq(services.previewOfService, input.baseServiceId),
					eq(services.previewGitRef, input.previewGitRef),
					isNull(services.deletedAt),
				),
			)
			.then((rows) => rows[0]);
		if (!current) return null;
		await tx
			.update(services)
			.set({
				previewCurrentRevisionId: null,
				previewGithubDeploymentId: null,
			})
			.where(eq(services.id, input.previewServiceId));
		return current;
	});
}

async function storePreviewGitHubDeployment(input: {
	baseServiceId: string;
	previewGitRef: string;
	previewServiceId: string;
	githubDeploymentId: number;
}) {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${input.baseServiceId}))`,
		);
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${input.baseServiceId}), hashtext(${input.previewGitRef}))`,
		);
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${input.previewServiceId}))`,
		);
		return tx
			.update(services)
			.set({ previewGithubDeploymentId: input.githubDeploymentId })
			.where(
				and(
					eq(services.id, input.previewServiceId),
					eq(services.previewOfService, input.baseServiceId),
					eq(services.previewGitRef, input.previewGitRef),
					isNull(services.previewCurrentRevisionId),
					isNull(services.previewGithubDeploymentId),
					isNull(services.deletedAt),
				),
			)
			.returning({ id: services.id })
			.then((rows) => rows.length > 0);
	});
}

export const previewSyncWorkflow = inngest.createFunction(
	{
		id: "preview-sync-workflow",
		triggers: [inngestEvents.previewSyncRequested],
		concurrency: [
			{
				limit: 1,
				key: 'event.data.baseServiceId + ":" + event.data.previewGitRef',
			},
		],
	},
	async ({ event, step }) => {
		const { baseServiceId, previewGitRef, force = false } = event.data;
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
		const previous = await step.run("load-current-preview-revision", () =>
			loadCurrentPreviewRevision(clone.serviceId),
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
		} catch (error) {
			const superseded = await step.run("clear-unmergeable-preview", () =>
				clearCurrentPreviewRevision({
					baseServiceId,
					previewGitRef,
					previewServiceId: clone.serviceId,
				}),
			);
			if (superseded?.previewCurrentRevisionId) {
				await step.run("deactivate-unmergeable-preview", () =>
					deactivatePreviewRuntime(clone.serviceId),
				);
			}
			if (superseded?.previewGithubDeploymentId) {
				await step.run("inactivate-unmergeable-deployment", () =>
					updateGitHubDeploymentStatus(
						context.githubRepo.installationId,
						context.githubRepo.repoFullName,
						superseded.previewGithubDeploymentId!,
						"inactive",
						{ description: "Preview merge ref is unavailable" },
					),
				);
			}
			if (!superseded) {
				return { status: "closed", reason: "preview_service_unavailable" };
			}
			const message =
				error instanceof Error
					? error.message
					: "Pull request merge ref unavailable";
			const failedDeploymentId = await step.run(
				"create-unmergeable-deployment",
				() =>
					createGitHubDeployment(
						context.githubRepo.installationId,
						context.githubRepo.repoFullName,
						pullRequest.head.sha,
						`preview/${context.service.name}/pr-${pullRequestNumber}`,
						`Preview unavailable for PR #${pullRequestNumber}`,
						{
							transientEnvironment: true,
							productionEnvironment: false,
							payload: {
								baseServiceId,
								previewServiceId: clone.serviceId,
								previewGitRef,
							},
						},
					),
			);
			const stored = await step.run("store-unmergeable-deployment", () =>
				storePreviewGitHubDeployment({
					baseServiceId,
					previewGitRef,
					previewServiceId: clone.serviceId,
					githubDeploymentId: failedDeploymentId,
				}),
			);
			if (!stored) {
				await step.run("inactivate-orphaned-unmergeable-deployment", () =>
					updateGitHubDeploymentStatus(
						context.githubRepo.installationId,
						context.githubRepo.repoFullName,
						failedDeploymentId,
						"inactive",
						{ description: "Preview was removed" },
					),
				);
				return { status: "closed", reason: "preview_service_unavailable" };
			}
			await step.run("mark-unmergeable-deployment-failed", () =>
				updateCurrentPreviewGitHubStatus({
					serviceId: clone.serviceId,
					serviceRevisionId: null,
					expectedDeploymentId: failedDeploymentId,
					state: "failure",
					description: message,
				}),
			);
			return { status: "failed", reason: "merge_ref_unavailable" };
		}

		if (!force && previous?.commitSha === mergeRef.sha) {
			return { status: "unchanged", serviceId: clone.serviceId };
		}

		const deploymentId = await step.run("create-github-deployment", () =>
			createGitHubDeployment(
				context.githubRepo.installationId,
				context.githubRepo.repoFullName,
				mergeRef.sha,
				`preview/${context.service.name}/pr-${pullRequestNumber}`,
				`Preview PR #${pullRequestNumber}: ${pullRequest.title}`.substring(
					0,
					140,
				),
				{
					transientEnvironment: true,
					productionEnvironment: false,
					payload: {
						baseServiceId,
						previewServiceId: clone.serviceId,
						previewGitRef,
					},
				},
			),
		);

		let activatedRevisionId: string | null = null;
		let queued: Awaited<ReturnType<typeof triggerResolvedBuildInternal>>;
		try {
			queued = await step.run("queue-preview-build", () =>
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
					expectedRepository: `https://github.com/${context.githubRepo.repoFullName}`,
					expectedBranch:
						context.githubRepo.deployBranch ?? context.githubRepo.defaultBranch,
					gitRef: mergeRef.gitRef,
					githubDeploymentId: deploymentId,
					idempotencyKey: force
						? `preview:${clone.serviceId}:${mergeRef.sha}:${event.id}`
						: `preview:${clone.serviceId}:${mergeRef.sha}`,
					beforeDispatch: async (serviceRevisionId) => {
						activatedRevisionId = serviceRevisionId;
						const activated = await db.transaction(async (tx) => {
							await tx.execute(
								sql`select pg_advisory_xact_lock(hashtext(${baseServiceId}))`,
							);
							await tx.execute(
								sql`select pg_advisory_xact_lock(hashtext(${baseServiceId}), hashtext(${previewGitRef}))`,
							);
							await tx.execute(
								sql`select pg_advisory_xact_lock(hashtext(${clone.serviceId}))`,
							);
							return tx
								.update(services)
								.set({
									previewCurrentRevisionId: serviceRevisionId,
									previewGithubDeploymentId: deploymentId,
								})
								.where(
									and(
										eq(services.id, clone.serviceId),
										eq(services.previewOfService, baseServiceId),
										eq(services.previewGitRef, previewGitRef),
										isNull(services.deletedAt),
									),
								)
								.returning({ id: services.id });
						});
						if (activated.length === 0) {
							throw new Error("Preview was closed before its build was queued");
						}
					},
				}),
			);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Failed to queue preview build";
			const previewStillExists = await step.run(
				"restore-preview-after-queue-failure",
				() =>
					db.transaction(async (tx) => {
						await tx.execute(
							sql`select pg_advisory_xact_lock(hashtext(${baseServiceId}))`,
						);
						await tx.execute(
							sql`select pg_advisory_xact_lock(hashtext(${baseServiceId}), hashtext(${previewGitRef}))`,
						);
						await tx.execute(
							sql`select pg_advisory_xact_lock(hashtext(${clone.serviceId}))`,
						);
						const current = await tx
							.select({
								previewCurrentRevisionId: services.previewCurrentRevisionId,
								previewGithubDeploymentId: services.previewGithubDeploymentId,
							})
							.from(services)
							.where(
								and(
									eq(services.id, clone.serviceId),
									isNull(services.deletedAt),
								),
							)
							.then((rows) => rows[0]);
						if (
							activatedRevisionId &&
							current?.previewCurrentRevisionId === activatedRevisionId &&
							current.previewGithubDeploymentId === deploymentId
						) {
							await tx
								.update(services)
								.set({
									previewCurrentRevisionId:
										previous?.previewCurrentRevisionId ?? null,
									previewGithubDeploymentId:
										previous?.previewGithubDeploymentId ?? null,
								})
								.where(eq(services.id, clone.serviceId));
						}
						return current != null;
					}),
			);
			if (activatedRevisionId) {
				await step.run("cancel-undispatched-preview", () =>
					cancelPreviewRevisionWork(clone.serviceId, activatedRevisionId!),
				);
			}
			await step.run("mark-preview-queue-failed", () =>
				updateGitHubDeploymentStatus(
					context.githubRepo.installationId,
					context.githubRepo.repoFullName,
					deploymentId,
					previewStillExists ? "failure" : "inactive",
					{
						description: previewStillExists
							? message.substring(0, 140)
							: "Preview was removed",
					},
				),
			);
			throw error;
		}

		await step.run("mark-preview-pending", () =>
			updateCurrentPreviewGitHubStatus({
				serviceId: clone.serviceId,
				serviceRevisionId: queued.serviceRevisionId,
				expectedDeploymentId: deploymentId,
				state: "pending",
				description: "Preview build queued",
			}),
		);
		if (previous?.previewCurrentRevisionId) {
			await step.run("cancel-superseded-preview", () =>
				cancelPreviewRevisionWork(
					clone.serviceId,
					previous.previewCurrentRevisionId!,
				),
			);
		}
		if (previous?.previewGithubDeploymentId) {
			await step.run("inactivate-superseded-deployment", () =>
				updateGitHubDeploymentStatus(
					context.githubRepo.installationId,
					context.githubRepo.repoFullName,
					previous.previewGithubDeploymentId!,
					"inactive",
					{ description: "Superseded by a newer preview revision" },
				),
			);
		}
		return { ...queued, deploymentId };
	},
);

export const previewCloseWorkflow = inngest.createFunction(
	{
		id: "preview-close-workflow",
		triggers: [inngestEvents.previewCloseRequested],
		concurrency: [
			{
				limit: 1,
				key: 'event.data.baseServiceId + ":" + event.data.previewGitRef',
			},
		],
	},
	async ({ event, step }) =>
		step.run("delete-preview", () => closePreviewFromEvent(event.data)),
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
		const stale = existing.filter(
			(clone) =>
				clone.previewGitRef &&
				(clone.deletedAt != null || !eligibleRefs.has(clone.previewGitRef)),
		);
		await Promise.all(
			stale.map((clone) =>
				step.run(`close-stale-${clone.previewGitRef}`, () =>
					closePreview(
						event.data.baseServiceId,
						clone.previewGitRef!,
						clone.deletedAt
							? "retrying preview deletion"
							: "pull request no longer eligible",
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
			closed: stale.length,
		};
	},
);

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
