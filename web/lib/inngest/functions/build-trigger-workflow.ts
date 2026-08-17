import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { builds, serviceRevisions, services } from "@/db/schema";
import {
	getTargetPlatformsForRevision,
	selectBuildServerForRevision,
} from "@/lib/build-assignment";
import { isFullCommitSha } from "@/lib/github";
import { createPreviewGitHubDeployment } from "@/lib/preview-deployments";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";
import { enqueueWork } from "@/lib/work-queue";
import { inngest } from "../client";
import { inngestEvents } from "../events";

function buildIdForRequest(buildRequestId: string, platform: string): string {
	const hash = createHash("sha256")
		.update(`${buildRequestId}:${platform}`)
		.digest("hex");
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export const buildTriggerWorkflow = inngest.createFunction(
	{
		id: "build-trigger-workflow",
		triggers: [inngestEvents.buildTrigger],
		concurrency: [{ limit: 1, key: "event.data.serviceId" }],
	},
	async ({ event, step }) => {
		const {
			serviceId,
			serviceRevisionId,
			buildRequestId,
			trigger,
			commitSha,
			commitMessage,
			branch,
			gitRef,
			author,
			githubDeploymentId,
			actor = null,
		} = event.data;
		if (!isFullCommitSha(commitSha)) {
			throw new Error("Build fan-out requires a full 40-character commit SHA");
		}
		const exactCommitSha = commitSha.toLowerCase();
		const revision = await step.run("get-build-revision", async () => {
			const revision = await db
				.select({
					specification: serviceRevisions.specification,
					previewGitRef: services.previewGitRef,
				})
				.from(serviceRevisions)
				.innerJoin(services, eq(services.id, serviceRevisions.serviceId))
				.where(
					and(
						eq(serviceRevisions.id, serviceRevisionId),
						eq(serviceRevisions.serviceId, serviceId),
					),
				)
				.then((rows) => rows[0]);
			if (!revision) throw new Error("Build service revision not found");
			const parsed = parseServiceRevisionSpec(revision.specification);
			if (
				parsed.source.type !== "github" ||
				parsed.source.commitSha !== exactCommitSha ||
				parsed.source.branch !== branch ||
				(revision.previewGitRef ?? undefined) !== gitRef
			) {
				throw new Error("Build trigger does not match its service revision");
			}
			return {
				specification: parsed,
				isPreview: revision.previewGitRef != null,
			};
		});
		const { specification, isPreview } = revision;

		const buildCreation = await step.run("create-builds", async () => {
			const targetPlatforms =
				await getTargetPlatformsForRevision(specification);
			if (targetPlatforms.length === 0) {
				throw new Error("No target platforms configured for this build");
			}
			if (new Set(targetPlatforms).size !== targetPlatforms.length) {
				throw new Error("Duplicate target platforms configured for this build");
			}

			const assignments = await Promise.all(
				targetPlatforms.map(async (platform) => ({
					id: buildIdForRequest(buildRequestId, platform),
					platform,
					serverId: await selectBuildServerForRevision(specification, platform),
				})),
			);
			const buildRows = assignments.map(({ id, platform }) => ({
				id,
				serviceId,
				serviceRevisionId,
				commitSha: exactCommitSha,
				commitMessage,
				branch,
				author,
				targetPlatform: platform,
				buildGroupId: buildRequestId,
				status: "pending" as const,
				githubDeploymentId,
			}));
			const persisted = await db.transaction(async (tx) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtext(${serviceId}))`,
				);
				if (isPreview) {
					const [activeService, latestRevision] = await Promise.all([
						tx
							.select({ id: services.id })
							.from(services)
							.where(
								and(eq(services.id, serviceId), isNull(services.deletedAt)),
							)
							.then((rows) => rows[0]),
						tx
							.select({ id: serviceRevisions.id })
							.from(serviceRevisions)
							.where(eq(serviceRevisions.serviceId, serviceId))
							.orderBy(
								desc(serviceRevisions.createdAt),
								desc(serviceRevisions.id),
							)
							.limit(1)
							.then((rows) => rows[0]),
					]);
					if (!activeService || latestRevision?.id !== serviceRevisionId) {
						return false;
					}
				}

				const inserted = await tx
					.insert(builds)
					.values(buildRows)
					.onConflictDoNothing({ target: builds.id })
					.returning({ id: builds.id });

				if (inserted.length !== buildRows.length) {
					const existingRows = await tx
						.select({
							id: builds.id,
							serviceId: builds.serviceId,
							serviceRevisionId: builds.serviceRevisionId,
							commitSha: builds.commitSha,
							branch: builds.branch,
							targetPlatform: builds.targetPlatform,
							buildGroupId: builds.buildGroupId,
						})
						.from(builds)
						.where(
							inArray(
								builds.id,
								buildRows.map((row) => row.id),
							),
						);
					const existingById = new Map(
						existingRows.map((row) => [row.id, row]),
					);
					for (const expected of buildRows) {
						const existing = existingById.get(expected.id);
						if (
							!existing ||
							existing.serviceId !== expected.serviceId ||
							existing.serviceRevisionId !== expected.serviceRevisionId ||
							existing.commitSha !== expected.commitSha ||
							existing.branch !== expected.branch ||
							existing.targetPlatform !== expected.targetPlatform ||
							existing.buildGroupId !== expected.buildGroupId
						) {
							throw new Error("Build request idempotency conflict");
						}
					}
				}
				return true;
			});

			return {
				stale: !persisted,
				buildIds: assignments.map((assignment) => assignment.id),
				buildGroupId: buildRequestId,
				assignments,
			};
		});
		if (buildCreation.stale) {
			return {
				status: "cancelled",
				reason: "superseded_preview_revision",
				buildGroupId: buildRequestId,
			};
		}
		const { buildIds, buildGroupId, assignments } = buildCreation;
		if (trigger === "preview" && !githubDeploymentId) {
			await step.run("create-preview-github-deployment", () =>
				createPreviewGitHubDeployment({
					serviceId,
					serviceRevisionId,
					commitSha: exactCommitSha,
				}),
			);
		}
		await step.run("enqueue-builds", () =>
			Promise.all(
				assignments.map((assignment) =>
					enqueueWork(
						assignment.serverId,
						"build",
						{ buildId: assignment.id },
						{ id: `build-work-${assignment.id}` },
					),
				),
			),
		);

		await step.run("send-build-started", async () => {
			await inngest.send(
				inngestEvents.buildStarted.create(
					{
						buildId: buildIds[0],
						serviceId,
						serviceRevisionId,
						buildGroupId,
						actor,
					},
					{
						id: `build-started-${buildRequestId}`,
					},
				),
			);
		});

		return { status: "triggered", buildIds, buildGroupId };
	},
);
