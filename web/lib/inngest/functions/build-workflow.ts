import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { builds } from "@/db/schema";
import {
	finalizeManifestBuild,
	getGroupBuilds,
} from "@/lib/manifest-finalization";
import { inngest } from "../client";
import { inngestEvents } from "../events";

type BuildStatus = typeof builds.$inferSelect.status;
type GroupBuild = Awaited<ReturnType<typeof getGroupBuilds>>[number];
const nonTerminalBuildStatuses: BuildStatus[] = [
	"pending",
	"claimed",
	"cloning",
	"building",
	"pushing",
];

function groupFailure(groupBuilds: GroupBuild[]) {
	return groupBuilds.some((build) =>
		["failed", "cancelled"].includes(build.status),
	);
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
		const { serviceId, serviceRevisionId, buildGroupId } = event.data;
		const manifestIdentity = { serviceId, serviceRevisionId, buildGroupId };
		const readGroup = () => getGroupBuilds(manifestIdentity);

		let groupBuilds = await step.run("get-group-builds", readGroup);
		if (groupBuilds.length === 0) {
			return { status: "failed", reason: "build_group_missing", buildGroupId };
		}
		if (groupFailure(groupBuilds)) {
			return { status: "failed", reason: "build_failed", buildGroupId };
		}

		const pendingBuilds = groupBuilds.filter(
			(build) => build.status !== "completed",
		);
		if (pendingBuilds.length > 0) {
			await Promise.all(
				pendingBuilds.map((build) =>
					step.waitForEvent(`wait-build-${build.id}`, {
						event: inngestEvents.buildCompleted,
						timeout: "60m",
						if: `async.data.buildId == "${build.id}"`,
					}),
				),
			);
			groupBuilds = await step.run("refresh-group-builds", readGroup);
		}

		if (groupBuilds.length === 0) {
			return { status: "failed", reason: "build_group_missing", buildGroupId };
		}
		if (groupFailure(groupBuilds)) {
			return { status: "failed", reason: "build_failed", buildGroupId };
		}
		if (groupBuilds.some((build) => build.status !== "completed")) {
			await step.run("handle-group-timeout", async () => {
				for (const build of groupBuilds) {
					if (build.status === "completed") continue;
					await db
						.update(builds)
						.set({
							status: "failed",
							error: "Build timed out after 60 minutes",
							completedAt: new Date(),
						})
						.where(
							and(
								eq(builds.id, build.id),
								inArray(builds.status, nonTerminalBuildStatuses),
							),
						);
				}
			});
			groupBuilds = await step.run("refresh-group-after-timeout", readGroup);
			if (groupBuilds.some((build) => build.status !== "completed")) {
				return { status: "failed", reason: "timeout", buildGroupId };
			}
		}

		let finalization = await step.run("finalize-existing-group-manifest", () =>
			finalizeManifestBuild(manifestIdentity),
		);
		if (!finalization) {
			await step.waitForEvent("wait-group-manifest", {
				event: inngestEvents.manifestCompleted,
				timeout: "10m",
				if: `async.data.serviceRevisionId == "${serviceRevisionId}" && async.data.buildGroupId == "${buildGroupId}"`,
			});
			finalization = await step.run("finalize-group-manifest-after-wait", () =>
				finalizeManifestBuild(manifestIdentity),
			);
		}
		if (!finalization) {
			return { status: "completed_no_manifest", buildGroupId };
		}
		if (finalization.status === "failed") {
			return { status: "failed", reason: "manifest_failed", buildGroupId };
		}

		return {
			status: "completed",
			buildGroupId,
			rolloutId: finalization.deployment.rolloutId,
		};
	},
);
