import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { builds, services, projects, serviceReplicas } from "@/db/schema";
import { inngest } from "../client";
import { deployService } from "@/actions/projects";

export const buildWorkflow = inngest.createFunction(
	{
		id: "build-workflow",
		cancelOn: [{ event: "build/cancelled", match: "data.buildGroupId" }],
	},
	{ event: "build/started" },
	async ({ event, step }) => {
		const { buildId, serviceId, buildGroupId } = event.data;

		if (!buildGroupId) {
			const result = await step.waitForEvent("wait-single-build", {
				event: "build/completed",
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

			const manifestResult = await step.waitForEvent("wait-manifest", {
				event: "manifest/completed",
				timeout: "10m",
				if: `async.data.serviceId == "${serviceId}"`,
			});

			if (!manifestResult) {
				return { status: "completed_no_manifest", buildId };
			}

			const shouldDeploy = await step.run("check-auto-deploy", async () => {
				const replicas = await db
					.select()
					.from(serviceReplicas)
					.where(eq(serviceReplicas.serviceId, serviceId));

				const service = await db
					.select()
					.from(services)
					.where(eq(services.id, serviceId))
					.then((r) => r[0]);

				return (
					replicas.length > 0 || (service?.autoPlace && service?.replicas > 0)
				);
			});

			if (shouldDeploy) {
				await step.run("trigger-deploy", async () => {
					await deployService(serviceId);
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
					event: "build/completed",
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

		const manifestResult = await step.waitForEvent("wait-group-manifest", {
			event: "manifest/completed",
			timeout: "10m",
			if: `async.data.buildGroupId == "${buildGroupId}"`,
		});

		if (!manifestResult) {
			return { status: "completed_no_manifest", buildGroupId };
		}

		const shouldDeploy = await step.run("check-auto-deploy-group", async () => {
			const replicas = await db
				.select()
				.from(serviceReplicas)
				.where(eq(serviceReplicas.serviceId, serviceId));

			const service = await db
				.select()
				.from(services)
				.where(eq(services.id, serviceId))
				.then((r) => r[0]);

			return (
				replicas.length > 0 || (service?.autoPlace && service?.replicas > 0)
			);
		});

		if (shouldDeploy) {
			await step.run("trigger-deploy-group", async () => {
				await deployService(serviceId);
			});
		}

		return { status: "completed", buildGroupId };
	},
);
