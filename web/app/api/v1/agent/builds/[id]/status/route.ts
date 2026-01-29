import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
	builds,
	services,
	projects,
	serviceReplicas,
	githubRepos,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { deployService } from "@/actions/projects";
import { updateGitHubDeploymentStatus } from "@/lib/github";
import { sendBuildFailureAlert } from "@/lib/email";
import { enqueueWork } from "@/lib/work-queue";

type StatusUpdate = {
	status: "cloning" | "building" | "pushing" | "completed" | "failed";
	error?: string;
};

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
	const { serverId } = auth;

	let update: StatusUpdate;
	try {
		update = JSON.parse(body);
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const [build] = await db
		.select()
		.from(builds)
		.where(and(eq(builds.id, buildId), eq(builds.claimedBy, serverId)));

	if (!build) {
		return NextResponse.json(
			{ error: "Build not found or not claimed by this agent" },
			{ status: 404 },
		);
	}

	if (build.status === "cancelled") {
		return NextResponse.json({ ok: true, cancelled: true });
	}

	const updateData: Record<string, unknown> = { status: update.status };

	if (update.status === "cloning" && !build.startedAt) {
		updateData.startedAt = new Date();
	}

	if (update.status === "completed" || update.status === "failed") {
		updateData.completedAt = new Date();
	}

	if (update.error) {
		updateData.error = update.error;
	}

	await db.update(builds).set(updateData).where(eq(builds.id, buildId));

	if (build.githubDeploymentId && build.githubRepoId) {
		try {
			const githubRepo = await db
				.select()
				.from(githubRepos)
				.where(eq(githubRepos.id, build.githubRepoId))
				.then((r) => r[0]);

			if (githubRepo) {
				const baseUrl =
					process.env.NEXT_PUBLIC_APP_URL || "https://cloud.techulus.com";
				const logUrl = `${baseUrl}/builds/${buildId}/logs`;

				if (
					update.status === "cloning" ||
					update.status === "building" ||
					update.status === "pushing"
				) {
					await updateGitHubDeploymentStatus(
						githubRepo.installationId,
						githubRepo.repoFullName,
						build.githubDeploymentId,
						"in_progress",
						{
							description: `Build ${update.status}...`,
							logUrl,
						},
					);
				} else if (update.status === "completed") {
					await updateGitHubDeploymentStatus(
						githubRepo.installationId,
						githubRepo.repoFullName,
						build.githubDeploymentId,
						"success",
						{
							description: "Build completed successfully",
							logUrl,
						},
					);
				} else if (update.status === "failed") {
					await updateGitHubDeploymentStatus(
						githubRepo.installationId,
						githubRepo.repoFullName,
						build.githubDeploymentId,
						"failure",
						{
							description: update.error || "Build failed",
							logUrl,
						},
					);
				}
			}
		} catch (error) {
			console.error(
				"[build:status] failed to update GitHub deployment:",
				error,
			);
		}
	}

	if (update.status === "failed") {
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

	if (update.status === "completed") {
		console.log(
			`[build:status] build ${buildId.slice(0, 8)} completed, targetPlatform=${build.targetPlatform}, serviceId=${build.serviceId}, commitSha=${build.commitSha?.slice(0, 8)}`,
		);

		const service = await db
			.select()
			.from(services)
			.where(eq(services.id, build.serviceId))
			.then((r) => r[0]);

		if (!service) {
			return NextResponse.json({ error: "Service not found" }, { status: 404 });
		}

		const project = await db
			.select()
			.from(projects)
			.where(eq(projects.id, service.projectId))
			.then((r) => r[0]);

		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}

		const registryHost = process.env.REGISTRY_HOST;
		if (!registryHost) {
			return NextResponse.json(
				{ error: "REGISTRY_HOST environment variable is required" },
				{ status: 500 },
			);
		}
		const commitSha = build.commitSha === "HEAD" ? "latest" : build.commitSha;
		const baseImageUri = `${registryHost}/${project.id}/${service.id}:${commitSha}`;

		if (build.targetPlatform) {
			const arch = build.targetPlatform.split("/")[1];
			const archImageUri = `${baseImageUri}-${arch}`;
			await db
				.update(builds)
				.set({ imageUri: archImageUri })
				.where(eq(builds.id, buildId));

			const groupBuilds = await db
				.select()
				.from(builds)
				.where(
					and(
						eq(builds.serviceId, build.serviceId),
						eq(builds.commitSha, build.commitSha),
					),
				);

			console.log(
				`[build:status] groupBuilds found: ${groupBuilds.length}, statuses: ${groupBuilds.map((b) => `${b.id.slice(0, 8)}=${b.status}`).join(", ")}`,
			);

			const allCompleted = groupBuilds.every(
				(b) => b.id === buildId || b.status === "completed",
			);

			console.log(`[build:status] allCompleted=${allCompleted}`);

			if (allCompleted && groupBuilds.length > 0) {
				console.log(
					`[build:complete] all ${groupBuilds.length} platform builds completed for ${build.serviceId}@${build.commitSha.slice(0, 8)}`,
				);

				const images = groupBuilds.map((b) => {
					const bArch = b.targetPlatform?.split("/")[1] || "amd64";
					return `${baseImageUri}-${bArch}`;
				});

				if (images.length > 1) {
					console.log(
						`[build:complete] enqueueing create_manifest for ${baseImageUri} to server ${serverId.slice(0, 8)}`,
					);
					await enqueueWork(serverId, "create_manifest", {
						images,
						finalImageUri: baseImageUri,
					});
				} else {
					console.log(
						`[build:complete] single platform build, copying image to final tag`,
					);
				}

				await db
					.update(services)
					.set({ image: baseImageUri })
					.where(eq(services.id, build.serviceId));

				const replicas = await db
					.select()
					.from(serviceReplicas)
					.where(eq(serviceReplicas.serviceId, build.serviceId));

				const shouldDeploy =
					replicas.length > 0 || (service.autoPlace && service.replicas > 0);

				if (shouldDeploy) {
					console.log(
						`[build:complete] triggering deployment for service ${build.serviceId}`,
					);

					try {
						await deployService(build.serviceId);
					} catch (error) {
						console.error("[build:complete] deployment failed:", error);
						await db
							.update(builds)
							.set({ error: `Deployment failed: ${error}` })
							.where(eq(builds.id, buildId));
					}
				} else {
					console.log(
						`[build:complete] no replicas configured for service ${build.serviceId}, skipping deployment`,
					);
				}
			} else {
				console.log(
					`[build:complete] waiting for other platform builds to complete for ${build.serviceId}@${build.commitSha.slice(0, 8)}`,
				);
			}
		} else {
			console.log(
				`[build:status] no targetPlatform, using legacy single-build path`,
			);

			await db
				.update(builds)
				.set({ imageUri: baseImageUri })
				.where(eq(builds.id, buildId));

			await db
				.update(services)
				.set({ image: baseImageUri })
				.where(eq(services.id, build.serviceId));

			const replicas = await db
				.select()
				.from(serviceReplicas)
				.where(eq(serviceReplicas.serviceId, build.serviceId));

			const shouldDeploy =
				replicas.length > 0 || (service.autoPlace && service.replicas > 0);

			if (shouldDeploy) {
				console.log(
					`[build:complete] triggering deployment for service ${build.serviceId}`,
				);

				try {
					await deployService(build.serviceId);
				} catch (error) {
					console.error("[build:complete] deployment failed:", error);
					await db
						.update(builds)
						.set({ error: `Deployment failed: ${error}` })
						.where(eq(builds.id, buildId));
				}
			} else {
				console.log(
					`[build:complete] no replicas configured for service ${build.serviceId}, skipping deployment`,
				);
			}
		}
	}

	console.log(
		`[build:status] build ${buildId.slice(0, 8)} status: ${update.status}`,
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

	const [build] = await db
		.select({ status: builds.status })
		.from(builds)
		.where(eq(builds.id, buildId));

	if (!build) {
		return NextResponse.json({ error: "Build not found" }, { status: 404 });
	}

	return NextResponse.json({ status: build.status });
}
