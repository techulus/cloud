import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
	builds,
	environments,
	projects,
	serviceRevisions,
	services,
} from "@/db/schema";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { revisionRepositoryFullName } from "@/lib/build-revision-source";
import { updateGitHubDeploymentStatus } from "@/lib/github";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { notify } from "@/lib/notifications";
import { updatePreviewGitHubStatus } from "@/lib/preview-deployments";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";
import { reportOperationFailure, reportServerError } from "@/lib/server-errors";
import { enqueueWork } from "@/lib/work-queue";

type StatusUpdate = {
	status: "cloning" | "building" | "pushing" | "completed" | "failed";
	error?: string;
	resolvedCommitSha?: string;
	imageUri?: string;
};

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

function imageRepository(image: string) {
	const withoutDigest = image.split("@", 1)[0];
	const lastSlash = withoutDigest.lastIndexOf("/");
	const tag = withoutDigest.lastIndexOf(":");
	return tag > lastSlash ? withoutDigest.slice(0, tag) : withoutDigest;
}

function digestImageRepository(image: string) {
	const match = /^(.*)@sha256:[0-9a-f]{64}$/.exec(image);
	return match?.[1] ?? null;
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

	const build = await db
		.select()
		.from(builds)
		.where(and(eq(builds.id, buildId), eq(builds.claimedBy, auth.serverId)))
		.then((rows) => rows[0]);
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
		.select({
			specification: serviceRevisions.specification,
			projectSlug: projects.slug,
			environmentName: environments.name,
			previewOfService: services.previewOfService,
		})
		.from(serviceRevisions)
		.innerJoin(services, eq(serviceRevisions.serviceId, services.id))
		.innerJoin(projects, eq(services.projectId, projects.id))
		.innerJoin(environments, eq(services.environmentId, environments.id))
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
		reportServerError(error, "agent.build.status.parse-revision", {
			tags: {
				buildId,
				serviceId: build.serviceId,
				revisionId: build.serviceRevisionId,
				serverId: auth.serverId,
			},
		});
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
		if (!update.imageUri || !digestImageRepository(update.imageUri)) {
			return NextResponse.json(
				{ error: "Completed build requires a valid image digest" },
				{ status: 400 },
			);
		}
		if (
			digestImageRepository(update.imageUri) !==
			imageRepository(specification.image)
		) {
			return NextResponse.json(
				{
					error: "Completed build artifact does not match its service revision",
				},
				{ status: 409 },
			);
		}
		platformImageUri = update.imageUri;
	}

	const updateData: Record<string, unknown> = { status: update.status };
	if (update.status === "cloning" && !build.startedAt) {
		updateData.startedAt = new Date();
	}
	if (update.status === "completed" || update.status === "failed") {
		updateData.completedAt = new Date();
	}
	if (update.error) updateData.error = update.error;
	if (platformImageUri) updateData.imageUri = platformImageUri;

	const transitionedBuild = await db
		.update(builds)
		.set(updateData)
		.where(
			and(
				eq(builds.id, buildId),
				eq(builds.claimedBy, auth.serverId),
				inArray(builds.status, transitionSources[update.status]),
			),
		)
		.returning()
		.then((rows) => rows[0]);
	let replayingTerminalUpdate = false;
	if (!transitionedBuild) {
		const currentBuild = await db
			.select()
			.from(builds)
			.where(and(eq(builds.id, buildId), eq(builds.claimedBy, auth.serverId)))
			.then((rows) => rows[0]);
		if (!currentBuild) {
			return NextResponse.json(
				{ error: "Build not found or not claimed by this agent" },
				{ status: 404 },
			);
		}
		if (currentBuild.status === "cancelled") {
			return NextResponse.json({ ok: true, cancelled: true });
		}
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
			const logUrl = revision.previewOfService
				? `${baseUrl}/dashboard/projects/${revision.projectSlug}/${revision.environmentName}/services/${build.serviceId}/builds/${buildId}`
				: `${baseUrl}/builds/${buildId}/logs`;
			if (revision.previewOfService) {
				await updatePreviewGitHubStatus({
					serviceId: build.serviceId,
					serviceRevisionId: build.serviceRevisionId,
					expectedDeploymentId: build.githubDeploymentId,
					state: update.status === "failed" ? "failure" : "in_progress",
					description:
						update.status === "completed"
							? "Preview image built; preparing deployment"
							: update.status === "failed"
								? "Preview build failed"
								: `Preview build ${update.status}...`,
					logUrl,
				});
			} else {
				const environmentUrl = `${baseUrl}/dashboard/projects/${revision.projectSlug}/${revision.environmentName}/services/${build.serviceId}`;
				const repository = revisionRepositoryFullName(
					specification.source.repository,
				);
				const installationId =
					specification.source.authentication.installationId;
				if (["cloning", "building", "pushing"].includes(update.status)) {
					await updateGitHubDeploymentStatus(
						installationId,
						repository,
						build.githubDeploymentId,
						"in_progress",
						{
							description: `Build ${update.status}...`,
							logUrl,
							environmentUrl,
						},
					);
				} else if (update.status === "completed") {
					await updateGitHubDeploymentStatus(
						installationId,
						repository,
						build.githubDeploymentId,
						"success",
						{
							description: "Build completed successfully",
							logUrl,
							environmentUrl,
						},
					);
				} else {
					await updateGitHubDeploymentStatus(
						installationId,
						repository,
						build.githubDeploymentId,
						"failure",
						{
							description: "Build failed",
							logUrl,
							environmentUrl,
						},
					);
				}
			}
		} catch (error) {
			reportServerError(error, "agent.build.status.github-deployment", {
				tags: {
					buildId,
					serviceId: build.serviceId,
					revisionId: build.serviceRevisionId,
					serverId: auth.serverId,
				},
			});
			console.error(
				"[build:status] failed to update GitHub deployment:",
				error,
			);
		}
	}

	if (update.status === "failed") {
		if (!replayingTerminalUpdate) {
			reportOperationFailure("build.failed", {
				occurrenceId: buildId,
				reason: "agent_reported_failure",
				tags: {
					buildId,
					serviceId: build.serviceId,
					revisionId: build.serviceRevisionId,
					serverId: auth.serverId,
				},
			});
			notify({
				kind: "build.failed",
				occurrenceId: buildId,
				serviceId: build.serviceId,
				buildId,
				error: update.error,
			}).catch((error) => {
				reportServerError(error, "agent.build.status.notification", {
					tags: {
						buildId,
						serviceId: build.serviceId,
						revisionId: build.serviceRevisionId,
					},
				});
				console.error(
					"[build:status] failed to enqueue build failure notification:",
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
					candidate.imageUri &&
					digestImageRepository(candidate.imageUri) ===
						imageRepository(specification.image)
				);
			});
		if (allCompleted) {
			const images = groupBuilds.map(
				(candidate) => candidate.imageUri as string,
			);
			await db.transaction(async (tx) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtext(${build.serviceId}))`,
				);
				const activeService = await tx
					.select({
						id: services.id,
						previewOfService: services.previewOfService,
					})
					.from(services)
					.where(
						and(eq(services.id, build.serviceId), isNull(services.deletedAt)),
					)
					.limit(1)
					.then((rows) => rows[0]);
				if (!activeService) {
					return;
				}
				if (activeService.previewOfService) {
					const latestRevision = await tx
						.select({ id: serviceRevisions.id })
						.from(serviceRevisions)
						.where(eq(serviceRevisions.serviceId, build.serviceId))
						.orderBy(
							desc(serviceRevisions.createdAt),
							desc(serviceRevisions.id),
						)
						.limit(1)
						.then((rows) => rows[0]);
					if (latestRevision?.id !== build.serviceRevisionId) return;
				}
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
					{ id: `manifest-work-${build.buildGroupId}`, tx },
				);
			});
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
	const build = await db
		.select({ status: builds.status })
		.from(builds)
		.where(eq(builds.id, buildId))
		.then((rows) => rows[0]);
	if (!build) {
		return NextResponse.json({ error: "Build not found" }, { status: 404 });
	}
	return NextResponse.json({ status: build.status });
}
