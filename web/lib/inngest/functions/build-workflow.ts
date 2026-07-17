import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { builds, serviceReplicas, services, workQueue } from "@/db/schema";
import { deployServiceInternal } from "@/lib/deploy-service";
import { inngest } from "../client";
import { inngestEvents } from "../events";

async function hasCompletedManifestWorkItem({
	serviceId,
	buildId,
	buildGroupId,
}: {
	serviceId: string;
	buildId?: string;
	buildGroupId?: string | null;
}) {
	const completedManifestItems = await db
		.select({ payload: workQueue.payload })
		.from(workQueue)
		.where(
			and(
				eq(workQueue.type, "create_manifest"),
				eq(workQueue.status, "completed"),
			),
		);

	return completedManifestItems.some((item) => {
		try {
			const payload = JSON.parse(item.payload) as {
				serviceId?: string;
				buildId?: string;
				buildGroupId?: string;
			};

			if (payload.serviceId !== serviceId) return false;
			if (buildGroupId) return payload.buildGroupId === buildGroupId;
			return !payload.buildGroupId && payload.buildId === buildId;
		} catch {
			return false;
		}
	});
}

export const buildWorkflow = inngest.createFunction(
	{
		id: "build-workflow",
		triggers: [inngestEvents.buildStarted],
		concurrency: [{ limit: 1, key: "event.data.serviceId" }],
		cancelOn: [
			{ event: inngestEvents.buildCancelled, match: "data.buildGroupId" },
		],
	},
	async ({ event, step }) => {
		const { buildId, serviceId, buildGroupId, actor = null } = event.data;

		if (!buildGroupId) {
			const result = await step.waitForEvent("wait-single-build", {
				event: inngestEvents.buildCompleted,
				timeout: "60m",
				if: `async.data.buildId == "${buildId}"`,
			});

			if (!result) {
				await step.run("handle-build-timeout", async () => {
					await db
						.update(builds)
						.set({
							status: "failed",
							error: "Build timed out after 60 minutes",
							completedAt: new Date(),
						})
						.where(eq(builds.id, buildId));
				});
				return { status: "failed", reason: "timeout", buildId };
			}

			if (result.data.status === "failed") {
				return { status: "failed", reason: result.data.error, buildId };
			}

			const manifestAlreadyCompleted = await step.run("check-existing-manifest", async () => {
				return hasCompletedManifestWorkItem({
					serviceId,
					buildId,
				});
			});

			if (!manifestAlreadyCompleted) {
				const manifestResult = await step.waitForEvent("wait-manifest", {
					event: inngestEvents.manifestCompleted,
					timeout: "10m",
					if: `async.data.serviceId == "${serviceId}"`,
				});

				if (!manifestResult) {
					return { status: "completed_no_manifest", buildId };
				}
			}

			const shouldDeploy = await step.run("check-auto-deploy", async () => {
				const replicas = await db
					.select()
					.from(serviceReplicas)
					.where(eq(serviceReplicas.serviceId, serviceId));

				const service = await db
					.select()
					.from(services)
					.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
					.then((r) => r[0]);

				return !!service && replicas.some((replica) => replica.count > 0);
			});

			if (shouldDeploy) {
				await step.run("trigger-deploy", async () => {
					await deployServiceInternal(serviceId, actor);
				});
			}

			return { status: "completed", buildId };
		}

		const groupBuilds = await step.run("get-group-builds", async () => {
			return db
				.select()
				.from(builds)
				.where(eq(builds.buildGroupId, buildGroupId));
		});

		const buildResults = await Promise.all(
			groupBuilds.map((build) =>
				step.waitForEvent(`wait-build-${build.id}`, {
					event: inngestEvents.buildCompleted,
					timeout: "60m",
					if: `async.data.buildId == "${build.id}"`,
				}),
			),
		);

		const timedOut = buildResults.some((r) => r === null);
		if (timedOut) {
			await step.run("handle-group-timeout", async () => {
				for (const build of groupBuilds) {
					const result = buildResults[groupBuilds.indexOf(build)];
					if (result === null) {
						await db
							.update(builds)
							.set({
								status: "failed",
								error: "Build timed out after 60 minutes",
								completedAt: new Date(),
							})
							.where(eq(builds.id, build.id));
					}
				}
			});
			return { status: "failed", reason: "timeout", buildGroupId };
		}

		const failed = buildResults.some((r) => r?.data.status === "failed");
		if (failed) {
			return { status: "failed", reason: "build_failed", buildGroupId };
		}

		const manifestAlreadyCompleted = await step.run("check-existing-group-manifest", async () => {
			return hasCompletedManifestWorkItem({
				serviceId,
				buildGroupId,
			});
		});

		if (!manifestAlreadyCompleted) {
			const manifestResult = await step.waitForEvent("wait-group-manifest", {
				event: inngestEvents.manifestCompleted,
				timeout: "10m",
				if: `async.data.buildGroupId == "${buildGroupId}"`,
			});

			if (!manifestResult) {
				return { status: "completed_no_manifest", buildGroupId };
			}
		}

		const shouldDeploy = await step.run("check-auto-deploy-group", async () => {
			const replicas = await db
				.select()
				.from(serviceReplicas)
				.where(eq(serviceReplicas.serviceId, serviceId));

			const service = await db
				.select()
				.from(services)
				.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
				.then((r) => r[0]);

			return !!service && replicas.some((replica) => replica.count > 0);
		});

		if (shouldDeploy) {
			await step.run("trigger-deploy-group", async () => {
				await deployServiceInternal(serviceId, actor);
			});
		}

		return { status: "completed", buildGroupId };
	},
);
