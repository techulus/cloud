import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { builds, serviceRevisions, workQueue } from "@/db/schema";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { revisionRepositoryFullName } from "@/lib/build-revision-source";
import { sendBuildFailureAlert } from "@/lib/email";
import { updateGitHubDeploymentStatus } from "@/lib/github";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";
import { enqueueWork } from "@/lib/work-queue";

type StatusUpdate = {
	attempt: number;
	status: "cloning" | "building" | "pushing" | "completed" | "failed";
	error?: string;
	resolvedCommitSha?: string;
	timings?: { cloneMs?: number; buildTotalMs?: number };
};

function validTimings(value: StatusUpdate["timings"]) {
	return (
		value === undefined ||
		(Object.keys(value).every((key) =>
			["cloneMs", "buildTotalMs"].includes(key),
		) &&
			Object.values(value).every(
				(duration) =>
					duration === undefined ||
					(Number.isInteger(duration) && duration >= 0),
			))
	);
}

const validStatuses = new Set<StatusUpdate["status"]>([
	"cloning",
	"building",
	"pushing",
	"completed",
	"failed",
]);

type BuildStatus = typeof builds.$inferSelect.status;
const terminalBuildStatuses = new Set<BuildStatus>([
	"completed",
	"failed",
	"cancelled",
]);
const transitionSources: Record<StatusUpdate["status"], BuildStatus[]> = {
	cloning: ["pending", "claimed", "cloning"],
	building: ["pending", "claimed", "cloning", "building"],
	pushing: ["pending", "claimed", "cloning", "building", "pushing"],
	completed: ["pending", "claimed", "cloning", "building", "pushing"],
	failed: ["pending", "claimed", "cloning", "building", "pushing"],
};

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockOwnedBuildWork(
	tx: Transaction,
	buildId: string,
	serverId: string,
	attempt: number,
) {
	return tx
		.select({ id: workQueue.id })
		.from(workQueue)
		.where(
			and(
				eq(workQueue.id, `build-work-${buildId}`),
				eq(workQueue.serverId, serverId),
				eq(workQueue.type, "build"),
				eq(workQueue.status, "processing"),
				eq(workQueue.attempts, attempt),
			),
		)
		.for("update")
		.then((rows) => rows[0]);
}

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

async function sendBuildCompletedEvent(data: {
	buildId: string;
	serviceId: string;
	serviceRevisionId: string;
	buildGroupId: string;
	status: "success" | "failed";
	imageUri?: string;
	error?: string;
}) {
	await inngest.send(
		inngestEvents.buildCompleted.create(data, {
			id: `build-completed-${data.buildId}`,
		}),
	);
}

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const body = await request.text();
	const auth = await verifyAgentRequest(request, body);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	const { id: buildId } = await params;
	let update: StatusUpdate;
	try {
		update = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (!validStatuses.has(update.status)) {
		return NextResponse.json(
			{ error: "Invalid build status" },
			{ status: 400 },
		);
	}
	if (!Number.isInteger(update.attempt) || update.attempt < 1) {
		return NextResponse.json(
			{ error: "Invalid work attempt" },
			{ status: 400 },
		);
	}
	if (!validTimings(update.timings)) {
		return NextResponse.json(
			{ error: "Invalid build timings" },
			{ status: 400 },
		);
	}

	const build = await db.transaction(async (tx) => {
		if (!(await lockOwnedBuildWork(tx, buildId, auth.serverId, update.attempt)))
			return;
		return tx
			.select()
			.from(builds)
			.where(and(eq(builds.id, buildId), eq(builds.claimedBy, auth.serverId)))
			.then((rows) => rows[0]);
	});
	if (!build) {
		return NextResponse.json(
			{ error: "Build not found or not claimed by this agent" },
			{ status: 404 },
		);
	}
	if (build.status === "cancelled") {
		return NextResponse.json({ ok: true, cancelled: true });
	}

	const revision = await db
		.select({ specification: serviceRevisions.specification })
		.from(serviceRevisions)
		.where(
			and(
				eq(serviceRevisions.id, build.serviceRevisionId),
				eq(serviceRevisions.serviceId, build.serviceId),
			),
		)
		.then((rows) => rows[0]);
	if (!revision) {
		return NextResponse.json(
			{ error: "Build service revision not found" },
			{ status: 404 },
		);
	}

	let specification: ReturnType<typeof parseServiceRevisionSpec>;
	try {
		specification = parseServiceRevisionSpec(revision.specification);
	} catch (error) {
		console.error("[build:status] invalid service revision:", error);
		return NextResponse.json(
			{ error: "Invalid build service revision" },
			{ status: 500 },
		);
	}
	if (
		specification.source.type !== "github" ||
		specification.source.commitSha !== build.commitSha ||
		specification.source.branch !== build.branch
	) {
		return NextResponse.json(
			{ error: "Build metadata does not match its service revision" },
			{ status: 409 },
		);
	}
	if (
		update.resolvedCommitSha &&
		update.resolvedCommitSha.toLowerCase() !== specification.source.commitSha
	) {
		return NextResponse.json(
			{ error: "Resolved commit does not match the service revision" },
			{ status: 409 },
		);
	}

	let platformImageUri: string | null = null;
	if (update.status === "completed") {
		try {
			platformImageUri = platformImageForTarget(
				specification.image,
				build.targetPlatform,
			);
		} catch (error) {
			return NextResponse.json(
				{
					error:
						error instanceof Error ? error.message : "Invalid build target",
				},
				{ status: 500 },
			);
		}
	}

	const updateData: Record<string, unknown> = { status: update.status };
	if (update.status === "cloning" && !build.startedAt) {
		updateData.startedAt = new Date();
	}
	if (update.status === "completed" || update.status === "failed") {
		updateData.completedAt = new Date();
	}
	if (update.error) updateData.error = update.error;
	if (update.timings) updateData.timings = update.timings;
	if (platformImageUri) updateData.imageUri = platformImageUri;

	const transition = await db.transaction(async (tx) => {
		if (!(await lockOwnedBuildWork(tx, buildId, auth.serverId, update.attempt)))
			return { kind: "unauthorized" } as const;
		const currentBuild = await tx
			.select()
			.from(builds)
			.where(and(eq(builds.id, buildId), eq(builds.claimedBy, auth.serverId)))
			.for("update")
			.then((rows) => rows[0]);
		if (!currentBuild) return { kind: "unauthorized" } as const;
		if (currentBuild.status === "cancelled")
			return { kind: "cancelled" } as const;
		if (transitionSources[update.status].includes(currentBuild.status)) {
			const transitionedBuild = await tx
				.update(builds)
				.set(updateData)
				.where(eq(builds.id, buildId))
				.returning()
				.then((rows) => rows[0]);
			return { kind: "transitioned", build: transitionedBuild } as const;
		}
		return { kind: "replay", build: currentBuild } as const;
	});
	let replayingTerminalUpdate = transition.kind === "replay";
	if (transition.kind !== "transitioned") {
		if (transition.kind === "unauthorized") {
			return NextResponse.json(
				{ error: "Build not found or not claimed by this agent" },
				{ status: 404 },
			);
		}
		if (transition.kind === "cancelled") {
			return NextResponse.json({ ok: true, cancelled: true });
		}
		const currentBuild = transition.build;
		if (
			!terminalBuildStatuses.has(currentBuild.status) ||
			currentBuild.status !== update.status
		) {
			return NextResponse.json(
				{
					error: `Cannot change build status from ${currentBuild.status} to ${update.status}`,
				},
				{ status: 409 },
			);
		}
		if (
			update.status === "completed" &&
			currentBuild.imageUri !== platformImageUri
		) {
			return NextResponse.json(
				{
					error: "Completed build artifact does not match its service revision",
				},
				{ status: 409 },
			);
		}
		replayingTerminalUpdate = true;
	}

	if (
		!replayingTerminalUpdate &&
		build.githubDeploymentId &&
		specification.source.authentication.type === "github_app"
	) {
		try {
			const baseUrl = process.env.APP_URL || "https://cloud.techulus.com";
			const logUrl = `${baseUrl}/builds/${buildId}/logs`;
			const repository = revisionRepositoryFullName(
				specification.source.repository,
			);
			const installationId = specification.source.authentication.installationId;
			if (["cloning", "building", "pushing"].includes(update.status)) {
				await updateGitHubDeploymentStatus(
					installationId,
					repository,
					build.githubDeploymentId,
					"in_progress",
					{ description: `Build ${update.status}...`, logUrl },
				);
			} else if (update.status === "completed") {
				await updateGitHubDeploymentStatus(
					installationId,
					repository,
					build.githubDeploymentId,
					"success",
					{ description: "Build completed successfully", logUrl },
				);
			} else {
				await updateGitHubDeploymentStatus(
					installationId,
					repository,
					build.githubDeploymentId,
					"failure",
					{ description: update.error || "Build failed", logUrl },
				);
			}
		} catch (error) {
			console.error(
				"[build:status] failed to update GitHub deployment:",
				error,
			);
		}
	}

	if (update.status === "failed") {
		if (!replayingTerminalUpdate) {
			sendBuildFailureAlert({
				serviceId: build.serviceId,
				buildId,
				error: update.error,
			}).catch((error) => {
				console.error(
					"[build:status] failed to send build failure alert:",
					error,
				);
			});
		}
		await sendBuildCompletedEvent({
			buildId,
			serviceId: build.serviceId,
			serviceRevisionId: build.serviceRevisionId,
			buildGroupId: build.buildGroupId,
			status: "failed",
			error: update.error,
		});
	}

	if (update.status === "completed") {
		if (!platformImageUri) {
			return NextResponse.json(
				{ error: "Invalid build artifact" },
				{ status: 500 },
			);
		}

		const groupBuilds = await db
			.select()
			.from(builds)
			.where(
				and(
					eq(builds.buildGroupId, build.buildGroupId),
					eq(builds.serviceRevisionId, build.serviceRevisionId),
				),
			);
		const allCompleted =
			groupBuilds.length > 0 &&
			groupBuilds.every((candidate) => {
				if (candidate.status !== "completed") return false;
				return (
					candidate.imageUri ===
					platformImageForTarget(specification.image, candidate.targetPlatform)
				);
			});
		if (allCompleted) {
			const images = groupBuilds.map((candidate) =>
				platformImageForTarget(specification.image, candidate.targetPlatform),
			);
			await enqueueWork(
				auth.serverId,
				"create_manifest",
				{
					images,
					finalImageUri: specification.image,
					serviceId: build.serviceId,
					serviceRevisionId: build.serviceRevisionId,
					buildGroupId: build.buildGroupId,
				},
				{ id: `manifest-work-${build.buildGroupId}` },
			);
		}

		await sendBuildCompletedEvent({
			buildId,
			serviceId: build.serviceId,
			serviceRevisionId: build.serviceRevisionId,
			buildGroupId: build.buildGroupId,
			status: "success",
			imageUri: platformImageUri,
		});
	}

	console.log(
		`[build:status] build ${buildId.slice(0, 8)} status: ${update.status}, revision=${build.serviceRevisionId.slice(0, 8)}`,
	);
	return NextResponse.json({ ok: true });
}

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await verifyAgentRequest(request);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}
	const { id: buildId } = await params;
	const attempt = Number(request.nextUrl.searchParams.get("attempt"));
	if (!Number.isInteger(attempt) || attempt < 1)
		return NextResponse.json(
			{ error: "Invalid work attempt" },
			{ status: 400 },
		);
	const build = await db.transaction(async (tx) => {
		if (!(await lockOwnedBuildWork(tx, buildId, auth.serverId, attempt)))
			return;
		return tx
			.select({ status: builds.status })
			.from(builds)
			.where(eq(builds.id, buildId))
			.then((rows) => rows[0]);
	});
	if (!build) {
		return NextResponse.json({ error: "Build not found" }, { status: 404 });
	}
	return NextResponse.json({ status: build.status });
}
