import { and, eq, inArray, sql } from "drizzle-orm";
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
import { updateGitHubDeploymentStatus } from "@/lib/github";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import {
	cleanupRegistryArtifactsForService,
	prepareRegistryArtifactCleanup,
} from "@/lib/registry-retention";
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
	const conditions = [
		eq(rollouts.serviceId, serviceId),
		inArray(rollouts.status, ["queued", "in_progress"]),
	];
	if (serviceRevisionId) {
		conditions.push(eq(rollouts.serviceRevisionId, serviceRevisionId));
	}
	const cancelled = await db
		.update(rollouts)
		.set({
			status: "failed",
			currentStage: "superseded",
			completedAt: new Date(),
		})
		.where(and(...conditions))
		.returning({ id: rollouts.id });
	if (cancelled.length === 0) return;

	const rolloutIds = cancelled.map(({ id }) => id);
	const rolloutDeployments = await db
		.select()
		.from(deployments)
		.where(inArray(deployments.rolloutId, rolloutIds));
	await db
		.update(deployments)
		.set(markDeploymentRemoved())
		.where(inArray(deployments.rolloutId, rolloutIds));
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
	await db.transaction((tx) =>
		enqueueReconcileForAllOnlineServers("preview_rollout_cancelled", tx),
	);
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

export async function deactivatePreviewRuntime(serviceId: string) {
	await Promise.all([cancelBuildRows(serviceId), cancelRolloutRows(serviceId)]);
	const runtime = await db
		.select()
		.from(deployments)
		.where(eq(deployments.serviceId, serviceId));
	await db
		.update(deployments)
		.set(markDeploymentRemoved())
		.where(eq(deployments.serviceId, serviceId));
	for (const deployment of runtime) {
		if (!deployment.containerId) continue;
		await enqueueWork(deployment.serverId, "stop", {
			deploymentId: deployment.id,
			containerId: deployment.containerId,
		});
	}
	await db.transaction((tx) =>
		enqueueReconcileForAllOnlineServers("preview_runtime_deactivated", tx),
	);
}

export async function deletePreviewService(
	baseServiceId: string,
	pullRequestNumber: number,
) {
	const claimed = await db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${baseServiceId}))`,
		);
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${baseServiceId}), ${pullRequestNumber})`,
		);
		const context = await tx
			.select({ service: services, githubRepo: githubRepos })
			.from(services)
			.innerJoin(githubRepos, eq(githubRepos.serviceId, services.id))
			.where(
				and(
					eq(services.previewOfServiceId, baseServiceId),
					eq(services.previewPullRequestNumber, pullRequestNumber),
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
			.set({ previewCurrentRevisionId: null })
			.where(eq(services.id, context.service.id));
		await tx
			.update(services)
			.set({
				deletedAt: new Date(),
				purgeAfter: new Date(),
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
	for (const deployment of runtime) {
		if (deployment.containerId) {
			await enqueueWork(deployment.serverId, "stop", {
				deploymentId: deployment.id,
				containerId: deployment.containerId,
			});
		}
		await db
			.delete(deploymentPorts)
			.where(eq(deploymentPorts.deploymentId, deployment.id));
	}
	await db
		.delete(deployments)
		.where(eq(deployments.serviceId, claimed.service.id));
	await db.transaction((tx) =>
		enqueueReconcileForAllOnlineServers("preview_deleted", tx),
	);
	await cleanupRegistryArtifactsForService(claimed.service.id);
	await db.delete(services).where(eq(services.id, claimed.service.id));
	return claimed;
}

export async function deletePreviewsForBaseService(
	baseServiceId: string,
	reason: string,
) {
	const previews = await db
		.select({ service: services, githubRepo: githubRepos })
		.from(services)
		.innerJoin(githubRepos, eq(githubRepos.serviceId, services.id))
		.where(
			eq(services.previewOfServiceId, baseServiceId),
		);
	for (const preview of previews) {
		const pullRequestNumber = preview.service.previewPullRequestNumber;
		if (!pullRequestNumber) continue;
		await deletePreviewService(baseServiceId, pullRequestNumber);
		if (!preview.service.previewGithubDeploymentId) continue;
		try {
			await updateGitHubDeploymentStatus(
				preview.githubRepo.installationId,
				preview.githubRepo.repoFullName,
				preview.service.previewGithubDeploymentId,
				"inactive",
				{ description: `Preview removed: ${reason}`.substring(0, 140) },
			);
		} catch (error) {
			console.error(
				`[preview:delete] failed to mark GitHub deployment ${preview.service.previewGithubDeploymentId} inactive:`,
				error,
			);
		}
	}
}

export async function deletePreviewsForGitHubInstallation(
	installationId: number,
	reason: string,
) {
	const previews = await db
		.select({
			baseServiceId: services.previewOfServiceId,
			pullRequestNumber: services.previewPullRequestNumber,
		})
		.from(services)
		.innerJoin(githubRepos, eq(githubRepos.serviceId, services.id))
		.where(
			eq(githubRepos.installationId, installationId),
		);
	const baseServiceIds = new Set(
		previews.flatMap((preview) =>
			preview.baseServiceId ? [preview.baseServiceId] : [],
		),
	);
	for (const baseServiceId of baseServiceIds) {
		await deletePreviewsForBaseService(baseServiceId, reason);
	}
}
