import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { builds, workQueue } from "@/db/schema";
import { deployServiceRevisionInternal } from "@/lib/deploy-service";

type BuildStatus = typeof builds.$inferSelect.status;
type GroupBuild = {
	id: string;
	status: BuildStatus;
	targetPlatform: string;
	imageUri: string | null;
};

export type ManifestIdentity = {
	serviceId: string;
	serviceRevisionId: string;
	buildGroupId: string;
};

type ManifestState =
	| {
			status: "completed";
			finalImageUri: string;
			immutableImageUri: string;
			images: string[];
	  }
	| { status: "failed" }
	| null;

export function platformImageForTarget(
	finalImage: string,
	targetPlatform: string,
) {
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

function imageRepository(image: string) {
	const withoutDigest = image.split("@", 1)[0];
	const colon = withoutDigest.lastIndexOf(":");
	return colon > withoutDigest.lastIndexOf("/")
		? withoutDigest.slice(0, colon)
		: withoutDigest;
}

export async function getGroupBuilds({
	serviceId,
	serviceRevisionId,
	buildGroupId,
}: ManifestIdentity) {
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

export async function manifestState({
	serviceId,
	serviceRevisionId,
	buildGroupId,
}: ManifestIdentity): Promise<ManifestState> {
	const item = await db
		.select({
			status: workQueue.status,
			payload: workQueue.payload,
			resultImageUri: workQueue.resultImageUri,
		})
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
		!item.resultImageUri ||
		!/^.+@sha256:[0-9a-f]{64}$/.test(item.resultImageUri) ||
		imageRepository(item.resultImageUri) !==
			imageRepository(payload.finalImageUri) ||
		!Array.isArray(payload.images) ||
		!payload.images.every((image): image is string => typeof image === "string")
	) {
		throw new Error("Completed build manifest is missing artifact metadata");
	}
	return {
		status: "completed",
		finalImageUri: payload.finalImageUri,
		immutableImageUri: item.resultImageUri,
		images: payload.images,
	};
}

export function validateCompletedGroup(
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

export async function finalizeManifestBuild(identity: ManifestIdentity) {
	const manifest = await manifestState(identity);
	if (!manifest || manifest.status === "failed") return manifest;

	const groupBuilds = await getGroupBuilds(identity);
	validateCompletedGroup(groupBuilds, manifest);
	const deployment = await deployServiceRevisionInternal(
		identity.serviceId,
		identity.serviceRevisionId,
		manifest.immutableImageUri,
		manifest.finalImageUri,
	);
	return { status: "completed" as const, deployment };
}
