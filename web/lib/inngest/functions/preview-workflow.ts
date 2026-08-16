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
	createOrRefreshPreviewClone,
	PREVIEW_RECONCILIATION_TTL_MS,
	updateCurrentPreviewGitHubStatus,
} from "@/lib/preview-deployments";
import {
	cancelPreviewRevisionWork,
	deactivatePreviewRuntime,
	deletePreviewService,
} from "@/lib/preview-lifecycle";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";
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
				isNull(services.previewOfServiceId),
				isNull(services.deletedAt),
			),
		)
		.then((rows) => rows[0]);
}

async function closePreview(
	baseServiceId: string,
	pullRequestNumber: number,
	reason: string,
) {
	const deleted = await deletePreviewService(baseServiceId, pullRequestNumber);
	if (deleted?.service.previewGithubDeploymentId) {
		try {
			await updateGitHubDeploymentStatus(
				deleted.githubRepo.installationId,
				deleted.githubRepo.repoFullName,
				deleted.service.previewGithubDeploymentId,
				"inactive",
				{ description: `Preview removed: ${reason}`.substring(0, 140) },
			);
		} catch (error) {
			console.error(
				`[preview:close] failed to mark GitHub deployment ${deleted.service.previewGithubDeploymentId} inactive:`,
				error,
			);
		}
	}
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
	pullRequestNumber: number,
) {
	return db
		.select({ service: services, githubRepo: githubRepos })
		.from(services)
		.innerJoin(githubRepos, eq(githubRepos.serviceId, services.id))
		.where(
			and(
				eq(services.previewOfServiceId, baseServiceId),
				eq(services.previewPullRequestNumber, pullRequestNumber),
				isNull(services.deletedAt),
			),
		)
		.then((rows) => rows[0]);
}

async function closePreviewFromEvent(input: {
	baseServiceId: string;
	pullRequestNumber: number;
	reason: string;
	verifyWithGitHub?: boolean;
}) {
	if (input.verifyWithGitHub) {
		const [baseContext, previewContext] = await Promise.all([
			loadBaseContext(input.baseServiceId),
			loadPreviewContext(input.baseServiceId, input.pullRequestNumber),
		]);
		if (!previewContext) return { status: "not_found" as const };
		if (baseContext) {
			const pullRequest = await getGitHubPullRequest(
				previewContext.githubRepo.installationId,
				previewContext.githubRepo.repoFullName,
				input.pullRequestNumber,
			);
			if (isEligiblePullRequest(baseContext, pullRequest)) {
				await enqueuePreviewSync(
					input.baseServiceId,
					input.pullRequestNumber,
					`stale-close:${pullRequest.updatedAt}`,
				);
				return { status: "stale" as const };
			}
		}
	}
	return closePreview(
		input.baseServiceId,
		input.pullRequestNumber,
		input.reason,
	);
}

async function loadCurrentPreviewRevision(serviceId: string) {
	const service = await db
		.select({
			previewCurrentRevisionId: services.previewCurrentRevisionId,
			previewGithubDeploymentId: services.previewGithubDeploymentId,
			previewError: services.previewError,
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

async function storePreviewPreBuildError(input: {
	baseServiceId: string;
	pullRequestNumber: number;
	previewServiceId: string;
	message: string;
}) {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${input.baseServiceId}))`,
		);
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${input.baseServiceId}), ${input.pullRequestNumber})`,
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
					eq(services.previewOfServiceId, input.baseServiceId),
					eq(services.previewPullRequestNumber, input.pullRequestNumber),
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
				previewError: input.message,
				previewExpiresAt: new Date(Date.now() + PREVIEW_RECONCILIATION_TTL_MS),
			})
			.where(eq(services.id, input.previewServiceId));
		return current;
	});
}

export const previewSyncWorkflow = inngest.createFunction(
	{
		id: "preview-sync-workflow",
		triggers: [inngestEvents.previewSyncRequested],
		concurrency: [
			{
				limit: 1,
				key: 'event.data.baseServiceId + ":" + event.data.pullRequestNumber',
			},
		],
	},
	async ({ event, step }) => {
		const { baseServiceId, pullRequestNumber, force = false } = event.data;
		const context = await step.run("load-base-service", () =>
			loadBaseContext(baseServiceId),
		);
		if (!context) {
			await step.run("close-orphaned-preview", () =>
				closePreview(
					baseServiceId,
					pullRequestNumber,
					"base service unavailable",
				),
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
				closePreview(
					baseServiceId,
					pullRequestNumber,
					"pull request ineligible",
				),
			);
			return { status: "closed", reason: "pull_request_ineligible" };
		}

		const clone = await step.run("refresh-preview-service", () =>
			createOrRefreshPreviewClone({
				baseServiceId,
				pullRequestNumber,
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
			const message =
				error instanceof Error
					? error.message
					: "Pull request merge ref unavailable";
			const superseded = await step.run("store-merge-ref-error", () =>
				storePreviewPreBuildError({
					baseServiceId,
					pullRequestNumber,
					previewServiceId: clone.serviceId,
					message,
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
			return { status: "failed", reason: "merge_ref_unavailable" };
		}

		if (
			!force &&
			previous?.commitSha === mergeRef.sha &&
			!previous.previewError
		) {
			await step.run("extend-preview-expiry", () =>
				db
					.update(services)
					.set({
						previewExpiresAt: new Date(
							Date.now() + PREVIEW_RECONCILIATION_TTL_MS,
						),
					})
					.where(eq(services.id, clone.serviceId)),
			);
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
						pullRequestNumber,
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
								sql`select pg_advisory_xact_lock(hashtext(${baseServiceId}), ${pullRequestNumber})`,
							);
							await tx.execute(
								sql`select pg_advisory_xact_lock(hashtext(${clone.serviceId}))`,
							);
							return tx
								.update(services)
								.set({
									previewCurrentRevisionId: serviceRevisionId,
									previewGithubDeploymentId: deploymentId,
									previewError: null,
									previewExpiresAt: new Date(
										Date.now() + PREVIEW_RECONCILIATION_TTL_MS,
									),
								})
								.where(
									and(
										eq(services.id, clone.serviceId),
										eq(services.previewOfServiceId, baseServiceId),
										eq(services.previewPullRequestNumber, pullRequestNumber),
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
			await step.run("mark-preview-queue-failed", async () => {
				await db.transaction(async (tx) => {
					await tx.execute(
						sql`select pg_advisory_xact_lock(hashtext(${baseServiceId}))`,
					);
					await tx.execute(
						sql`select pg_advisory_xact_lock(hashtext(${baseServiceId}), ${pullRequestNumber})`,
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
							and(eq(services.id, clone.serviceId), isNull(services.deletedAt)),
						)
						.then((rows) => rows[0]);
					if (current) {
						try {
							await updateGitHubDeploymentStatus(
								context.githubRepo.installationId,
								context.githubRepo.repoFullName,
								deploymentId,
								"failure",
								{ description: message.substring(0, 140) },
							);
						} catch (statusError) {
							console.error(
								"[preview:sync] failed to report build queue failure:",
								statusError,
							);
						}
					}
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
								previewError: message,
							})
							.where(eq(services.id, clone.serviceId));
					} else if (!activatedRevisionId && current) {
						await tx
							.update(services)
							.set({ previewError: message })
							.where(eq(services.id, clone.serviceId));
					}
				});
			});
			if (activatedRevisionId) {
				await step.run("cancel-undispatched-preview", () =>
					cancelPreviewRevisionWork(clone.serviceId, activatedRevisionId!),
				);
			}
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
				key: 'event.data.baseServiceId + ":" + event.data.pullRequestNumber',
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
					.select({ pullRequestNumber: services.previewPullRequestNumber })
					.from(services)
					.where(
						and(
							eq(services.previewOfServiceId, event.data.baseServiceId),
							isNull(services.deletedAt),
						),
					),
			);
			for (const clone of clones) {
				if (!clone.pullRequestNumber) continue;
				await step.run(`close-disabled-${clone.pullRequestNumber}`, () =>
					closePreview(
						event.data.baseServiceId,
						clone.pullRequestNumber!,
						"preview deployments disabled",
					),
				);
			}
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
		const eligibleNumbers = new Set(
			eligible.map((pullRequest) => pullRequest.number),
		);
		const existing = await step.run("list-existing-previews", () =>
			db
				.select({ pullRequestNumber: services.previewPullRequestNumber })
				.from(services)
				.where(
					and(
						eq(services.previewOfServiceId, event.data.baseServiceId),
						isNull(services.deletedAt),
					),
				),
		);
		const stale = existing.filter(
			(clone) =>
				clone.pullRequestNumber &&
				!eligibleNumbers.has(clone.pullRequestNumber),
		);
		for (const clone of stale) {
			await step.run(`close-stale-${clone.pullRequestNumber}`, () =>
				closePreview(
					event.data.baseServiceId,
					clone.pullRequestNumber!,
					"pull request no longer eligible",
				),
			);
		}
		for (const pullRequest of eligible) {
			await step.run(`queue-pr-${pullRequest.number}`, () =>
				enqueuePreviewSync(
					event.data.baseServiceId,
					pullRequest.number,
					`reconcile:${pullRequest.updatedAt}`,
				),
			);
		}
		return {
			status: "queued",
			count: eligible.length,
			closed: stale.length,
		};
	},
);

async function enqueuePreviewSync(
	baseServiceId: string,
	pullRequestNumber: number,
	idSuffix: string,
) {
	await inngest.send(
		inngestEvents.previewSyncRequested.create(
			{ baseServiceId, pullRequestNumber },
			{
				id: `preview-reconcile:${baseServiceId}:${pullRequestNumber}:${idSuffix}`,
			},
		),
	);
}
