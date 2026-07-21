import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { builds, serviceRevisions } from "@/db/schema";
import {
	getTargetPlatformsForRevision,
	selectBuildServerForRevision,
} from "@/lib/build-assignment";
import { isFullCommitSha } from "@/lib/github";
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
			commitSha,
			commitMessage,
			branch,
			author,
			githubDeploymentId,
			actor = null,
		} = event.data;
		if (!isFullCommitSha(commitSha)) {
			throw new Error("Build fan-out requires a full 40-character commit SHA");
		}
		const exactCommitSha = commitSha.toLowerCase();
		const specification = await step.run("get-build-revision", async () => {
			const revision = await db
				.select({ specification: serviceRevisions.specification })
				.from(serviceRevisions)
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
				parsed.source.branch !== branch
			) {
				throw new Error("Build trigger does not match its service revision");
			}
			return parsed;
		});

		const { buildIds, buildGroupId } = await step.run(
			"create-builds",
			async () => {
				const targetPlatforms =
					await getTargetPlatformsForRevision(specification);
				if (targetPlatforms.length === 0) {
					throw new Error("No target platforms configured for this build");
				}
				if (new Set(targetPlatforms).size !== targetPlatforms.length) {
					throw new Error(
						"Duplicate target platforms configured for this build",
					);
				}

				const assignments = await Promise.all(
					targetPlatforms.map(async (platform) => ({
						id: buildIdForRequest(buildRequestId, platform),
						platform,
						serverId: await selectBuildServerForRevision(
							specification,
							platform,
						),
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
				const inserted = await db
					.insert(builds)
					.values(buildRows)
					.onConflictDoNothing({ target: builds.id })
					.returning({ id: builds.id });

				if (inserted.length !== buildRows.length) {
					const existingRows = await db
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

				for (const assignment of assignments) {
					await enqueueWork(
						assignment.serverId,
						"build",
						{ buildId: assignment.id },
						{ id: `build-work-${assignment.id}` },
					);
				}

				return {
					buildIds: assignments.map((assignment) => assignment.id),
					buildGroupId: buildRequestId,
				};
			},
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
