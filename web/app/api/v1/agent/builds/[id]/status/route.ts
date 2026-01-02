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

	if (update.status === "completed") {
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
		const imageUri = `${registryHost}/${project.id}/${service.id}:${commitSha}`;

		await db.update(builds).set({ imageUri }).where(eq(builds.id, buildId));

		await db
			.update(services)
			.set({ image: imageUri })
			.where(eq(services.id, build.serviceId));

		const replicas = await db
			.select()
			.from(serviceReplicas)
			.where(eq(serviceReplicas.serviceId, build.serviceId));

		if (replicas.length > 0) {
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
