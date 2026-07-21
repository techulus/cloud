import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { builds, workQueue } from "@/db/schema";
import { deployServiceRevisionInternal } from "@/lib/deploy-service";
import { inngest } from "../client";
import { inngestEvents } from "../events";

type BuildStatus = typeof builds.$inferSelect.status;
type GroupBuild = {
	id: string;
	status: BuildStatus;
	targetPlatform: string;
	imageUri: string | null;
};
type ManifestState =
	| {
			status: "completed";
			finalImageUri: string;
			images: string[];
	  }
	| { status: "failed" }
	| null;

const nonTerminalBuildStatuses: BuildStatus[] = [
	"pending",
	"claimed",
	"cloning",
	"building",
	"pushing",
];

function platformImageForTarget(finalImage: string, targetPlatform: string) {
	const [operatingSystem, architecture, ...extra] = targetPlatform.split("/");
	if (
		operatingSystem !== "linux" ||
		!architecture ||
		extra.length > 0 ||
		!["amd64", "arm64"].includes(architecture)
	) {
		throw new Error(`Invalid build target platform: ${targetPlatform}`);
	}
	return `${finalImage}-${architecture}`;
}

async function getGroupBuilds(
	serviceId: string,
	serviceRevisionId: string,
	buildGroupId: string,
) {
	return db
		.select({
			id: builds.id,
			status: builds.status,
			targetPlatform: builds.targetPlatform,
			imageUri: builds.imageUri,
		})
		.from(builds)
		.where(
			and(
				eq(builds.serviceId, serviceId),
				eq(builds.serviceRevisionId, serviceRevisionId),
				eq(builds.buildGroupId, buildGroupId),
			),
		);
}

function groupFailure(groupBuilds: GroupBuild[]) {
	return groupBuilds.some((build) =>
		["failed", "cancelled"].includes(build.status),
	);
}

async function manifestState({
	serviceId,
	serviceRevisionId,
	buildGroupId,
}: {
	serviceId: string;
	serviceRevisionId: string;
	buildGroupId: string;
}): Promise<ManifestState> {
	const item = await db
		.select({ status: workQueue.status, payload: workQueue.payload })
		.from(workQueue)
		.where(
			and(
				eq(workQueue.id, `manifest-work-${buildGroupId}`),
				eq(workQueue.type, "create_manifest"),
			),
		)
		.then((rows) => rows[0]);
	if (!item || !["completed", "failed"].includes(item.status)) return null;

	let payload: {
		serviceId?: string;
		serviceRevisionId?: string;
		buildGroupId?: string;
		finalImageUri?: string;
		images?: unknown;
	};
	try {
		payload = JSON.parse(item.payload);
	} catch {
		throw new Error("Build manifest work item has an invalid payload");
	}
	if (
		payload.serviceId !== serviceId ||
		payload.serviceRevisionId !== serviceRevisionId ||
		payload.buildGroupId !== buildGroupId
	) {
		throw new Error("Build manifest work item identity does not match");
	}
	if (item.status === "failed") return { status: "failed" };
	if (
		!payload.finalImageUri ||
		!Array.isArray(payload.images) ||
		!payload.images.every((image): image is string => typeof image === "string")
	) {
		throw new Error("Completed build manifest is missing artifact metadata");
	}
	return {
		status: "completed",
		finalImageUri: payload.finalImageUri,
		images: payload.images,
	};
}

function validateCompletedGroup(
	groupBuilds: GroupBuild[],
	manifest: Extract<ManifestState, { status: "completed" }>,
) {
	if (groupBuilds.length === 0) throw new Error("Build group is missing");
	const expectedImages = groupBuilds.map((build) => {
		if (build.status !== "completed") {
			throw new Error("Build group is not complete");
		}
		const expectedImage = platformImageForTarget(
			manifest.finalImageUri,
			build.targetPlatform,
		);
		if (build.imageUri !== expectedImage) {
			throw new Error("Platform build artifact does not match its revision");
		}
		return expectedImage;
	});
	const expected = [...expectedImages].sort();
	const actual = [...manifest.images].sort();
	if (
		expected.length !== actual.length ||
		expected.some((image, index) => image !== actual[index])
	) {
		throw new Error(
			"Build manifest does not contain the complete platform group",
		);
	}
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
		const readGroup = () =>
			getGroupBuilds(serviceId, serviceRevisionId, buildGroupId);

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

		const manifestIdentity = { serviceId, serviceRevisionId, buildGroupId };
		let manifest = await step.run("check-existing-group-manifest", () =>
			manifestState(manifestIdentity),
		);
		if (!manifest) {
			await step.waitForEvent("wait-group-manifest", {
				event: inngestEvents.manifestCompleted,
				timeout: "10m",
				if: `async.data.serviceRevisionId == "${serviceRevisionId}" && async.data.buildGroupId == "${buildGroupId}"`,
			});
			manifest = await step.run("check-group-manifest-after-wait", () =>
				manifestState(manifestIdentity),
			);
		}
		if (!manifest) {
			return { status: "completed_no_manifest", buildGroupId };
		}
		if (manifest.status === "failed") {
			return { status: "failed", reason: "manifest_failed", buildGroupId };
		}

		groupBuilds = await step.run("validate-group-before-deploy", readGroup);
		validateCompletedGroup(groupBuilds, manifest);
		const deployment = await step.run("trigger-deploy-group", () =>
			deployServiceRevisionInternal(
				serviceId,
				serviceRevisionId,
				manifest.finalImageUri,
			),
		);
		return {
			status: "completed",
			buildGroupId,
			rolloutId: deployment.rolloutId,
		};
	},
);
