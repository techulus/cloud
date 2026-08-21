import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
	builds,
	deploymentPorts,
	deployments,
	githubRepos,
	rollouts,
	services,
} from "@/db/schema";
import { markDeploymentRemoved } from "@/lib/deployment-status";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { inactivatePreviewGitHubDeployments } from "@/lib/preview-deployments";
import {
	cleanupRegistryArtifactsForService,
	prepareRegistryArtifactCleanup,
} from "@/lib/registry-retention";
import { reportServerError } from "@/lib/server-errors";
import { pullRequestNumberFromMergeRef } from "@/lib/service-revision-spec";
import {
	enqueueReconcileForAllOnlineServers,
	enqueueWork,
} from "@/lib/work-queue";

const activeBuildStatuses = [
	"pending",
	"claimed",
	"cloning",
	"building",
	"pushing",
] as const;

async function cancelBuildRows(serviceId: string, serviceRevisionId?: string) {
	const conditions = [
		eq(builds.serviceId, serviceId),
		inArray(builds.status, [...activeBuildStatuses]),
	];
	if (serviceRevisionId) {
		conditions.push(eq(builds.serviceRevisionId, serviceRevisionId));
	}
	const cancelled = await db
		.update(builds)
		.set({ status: "cancelled", completedAt: new Date() })
		.where(and(...conditions))
		.returning({ buildGroupId: builds.buildGroupId });
	for (const buildGroupId of new Set(
		cancelled.map((row) => row.buildGroupId),
	)) {
		await inngest.send(
			inngestEvents.buildCancelled.create(
				{ buildId: `preview-${buildGroupId}`, buildGroupId },
				{ id: `preview-build-cancelled-${buildGroupId}` },
			),
		);
	}
}

async function cancelRolloutRows(
	serviceId: string,
	serviceRevisionId?: string,
) {
	const { cancelled, rolloutDeployments } = await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${serviceId}))`);
		const conditions = [
			eq(rollouts.serviceId, serviceId),
			inArray(rollouts.status, ["queued", "in_progress"]),
		];
		if (serviceRevisionId) {
			conditions.push(eq(rollouts.serviceRevisionId, serviceRevisionId));
		}
		const cancelled = await tx
			.update(rollouts)
			.set({
				status: "failed",
				currentStage: "superseded",
				completedAt: new Date(),
			})
			.where(and(...conditions))
			.returning({ id: rollouts.id });
		if (cancelled.length === 0) {
			return { cancelled, rolloutDeployments: [] };
		}

		const rolloutIds = cancelled.map(({ id }) => id);
		const rolloutDeployments = await tx
			.select()
			.from(deployments)
			.where(inArray(deployments.rolloutId, rolloutIds));
		if (
			rolloutDeployments.some(
				(deployment) => deployment.trafficState === "active",
			)
		) {
			await tx
				.update(deployments)
				.set({ trafficState: "active" })
				.where(
					and(
						eq(deployments.serviceId, serviceId),
						eq(deployments.trafficState, "draining"),
					),
				);
		}
		await tx
			.update(deployments)
			.set(markDeploymentRemoved())
			.where(inArray(deployments.rolloutId, rolloutIds));
		await enqueueReconcileForAllOnlineServers("preview_rollout_cancelled", tx);
		return { cancelled, rolloutDeployments };
	});
	if (cancelled.length === 0) return;

	for (const deployment of rolloutDeployments) {
		if (!deployment.containerId) continue;
		await enqueueWork(deployment.serverId, "stop", {
			deploymentId: deployment.id,
			containerId: deployment.containerId,
		});
	}
	for (const { id } of cancelled) {
		await inngest.send(
			inngestEvents.rolloutCancelled.create(
				{ rolloutId: id },
				{ id: `preview-rollout-cancelled-${id}` },
			),
		);
	}
}

export async function cancelPreviewRevisionWork(
	serviceId: string,
	serviceRevisionId: string,
) {
	await Promise.all([
		cancelBuildRows(serviceId, serviceRevisionId),
		cancelRolloutRows(serviceId, serviceRevisionId),
	]);
}

export async function deletePreviewService(
	baseServiceId: string,
	previewGitRef: string,
	reason = "removed",
	options: { reportGitHubDeployment?: boolean } = {},
) {
	pullRequestNumberFromMergeRef(previewGitRef);
	const claimed = await db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${baseServiceId}))`,
		);
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${baseServiceId}), hashtext(${previewGitRef}))`,
		);
		const context = await tx
			.select({ service: services })
			.from(services)
			.where(
				and(
					eq(services.previewOfService, baseServiceId),
					eq(services.previewGitRef, previewGitRef),
				),
			)
			.then((rows) => rows[0]);
		if (!context) return null;
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${context.service.id}))`,
		);
		if (!(await prepareRegistryArtifactCleanup(tx, context.service.id))) {
			throw new Error(
				"Preview deletion deferred while registry manifest work is processing",
			);
		}
		await tx
			.update(services)
			.set({
				deletedAt: new Date(),
				purgeAfter: null,
				deletionStatus: "deleting",
			})
			.where(eq(services.id, context.service.id));
		return context;
	});
	if (!claimed) return null;

	await Promise.all([
		cancelBuildRows(claimed.service.id),
		cancelRolloutRows(claimed.service.id),
	]);
	const runtime = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, claimed.service.id));
	await Promise.all(
		runtime.flatMap((deployment) =>
			deployment.containerId
				? [
						enqueueWork(deployment.serverId, "stop", {
							deploymentId: deployment.id,
							containerId: deployment.containerId,
						}),
					]
				: [],
		),
	);
	if (runtime.length > 0) {
		await db.delete(deploymentPorts).where(
			inArray(
				deploymentPorts.deploymentId,
				runtime.map((deployment) => deployment.id),
			),
		);
	}
	await db
		.delete(deployments)
		.where(eq(deployments.serviceId, claimed.service.id));
	await db.transaction((tx) =>
		enqueueReconcileForAllOnlineServers("preview_deleted", tx),
	);
	await cleanupRegistryArtifactsForService(claimed.service.id);
	if (options.reportGitHubDeployment !== false) {
		try {
			await inactivatePreviewGitHubDeployments({
				serviceId: claimed.service.id,
				description: `Preview removed: ${reason}`,
			});
		} catch (error) {
			reportServerError(error, "preview.github-deployments.inactivate", {
				tags: { serviceId: claimed.service.id },
			});
			console.error(
				`[preview-lifecycle] failed to inactivate GitHub deployments for ${claimed.service.id}:`,
				error,
			);
		}
	}
	await db.delete(services).where(eq(services.id, claimed.service.id));
	return claimed;
}

export async function deletePreviewsForBaseService(
	baseServiceId: string,
	reason: string,
	options: { reportGitHubDeployment?: boolean } = {},
) {
	const previews = await db
		.select({ service: services })
		.from(services)
		.where(eq(services.previewOfService, baseServiceId));
	for (const preview of previews) {
		const previewGitRef = preview.service.previewGitRef;
		if (!previewGitRef) continue;
		await deletePreviewService(baseServiceId, previewGitRef, reason, options);
	}
}

export async function deletePreviewsForGitHubInstallation(
	installationId: number,
	reason: string,
	options: {
		removeRepositoryLinks?: boolean;
	} = {},
) {
	const baseServiceIds = await db.transaction(async (tx) => {
		const ids = await tx
			.select({ id: services.id })
			.from(services)
			.innerJoin(githubRepos, eq(githubRepos.serviceId, services.id))
			.where(
				and(
					eq(githubRepos.installationId, installationId),
					isNull(services.previewOfService),
				),
			)
			.then((rows) => rows.map(({ id }) => id).sort());
		for (const id of ids) {
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
		}
		if (ids.length > 0) {
			await tx
				.update(services)
				.set({ previewDeploymentsEnabled: false })
				.where(inArray(services.id, ids));
		}
		if (options.removeRepositoryLinks) {
			await tx
				.delete(githubRepos)
				.where(eq(githubRepos.installationId, installationId));
		}
		return ids;
	});
	for (const baseServiceId of baseServiceIds) {
		await deletePreviewsForBaseService(baseServiceId, reason, {
			reportGitHubDeployment: false,
		});
	}
}
