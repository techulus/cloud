import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { builds } from "@/db/schema";
import { inngest } from "../client";
import {
	selectBuildServerForPlatform,
	getTargetPlatformsForService,
} from "@/lib/build-assignment";
import { enqueueWork } from "@/lib/work-queue";

export const buildTriggerWorkflow = inngest.createFunction(
	{
		id: "build-trigger-workflow",
	},
	{ event: "build/trigger" },
	async ({ event, step }) => {
		const {
			serviceId,
			githubRepoId,
			commitSha,
			commitMessage,
			branch,
			author,
			githubDeploymentId,
		} = event.data;

		const pendingBuild = await step.run("check-pending-build", async () => {
			const existing = await db
				.select()
				.from(builds)
				.where(
					and(eq(builds.serviceId, serviceId), eq(builds.status, "pending")),
				)
				.then((r) => r[0]);

			return !!existing;
		});

		if (pendingBuild) {
			return { status: "skipped", reason: "build_already_pending" };
		}

		const { buildIds, buildGroupId } = await step.run(
			"create-builds",
			async () => {
				const targetPlatforms = await getTargetPlatformsForService(serviceId);
				const groupId = randomUUID();
				const ids: string[] = [];

				for (const platform of targetPlatforms) {
					const buildId = randomUUID();
					ids.push(buildId);

					await db.insert(builds).values({
						id: buildId,
						githubRepoId: githubRepoId ?? null,
						serviceId,
						commitSha,
						commitMessage,
						branch,
						author,
						targetPlatform: platform,
						buildGroupId: groupId,
						status: "pending",
						githubDeploymentId,
					});

					const serverId = await selectBuildServerForPlatform(
						serviceId,
						platform,
					);
					await enqueueWork(serverId, "build", { buildId });
				}

				return { buildIds: ids, buildGroupId: groupId };
			},
		);

		await step.run("send-build-started", async () => {
			await inngest.send({
				name: "build/started",
				data: {
					buildId: buildIds[0],
					serviceId,
					buildGroupId,
				},
			});
		});

		return { status: "triggered", buildIds, buildGroupId };
	},
);
