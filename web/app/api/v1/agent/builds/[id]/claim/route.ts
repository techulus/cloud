import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
	builds,
	githubRepos,
	githubInstallations,
	services,
	projects,
	secrets,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { getInstallationToken, buildCloneUrl } from "@/lib/github";

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await verifyAgentRequest(request);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	const { id: buildId } = await params;
	const { serverId } = auth;

	const result = await db
		.update(builds)
		.set({
			status: "claimed",
			claimedBy: serverId,
			claimedAt: new Date(),
		})
		.where(and(eq(builds.id, buildId), eq(builds.status, "pending")))
		.returning();

	if (result.length === 0) {
		return NextResponse.json(
			{ error: "Build already claimed or not found" },
			{ status: 409 },
		);
	}

	const build = result[0];

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

	let cloneUrl: string;

	if (service.githubRepoUrl) {
		cloneUrl = service.githubRepoUrl;
		if (!cloneUrl.endsWith(".git")) {
			cloneUrl = cloneUrl + ".git";
		}
	} else if (build.githubRepoId) {
		const githubRepo = await db
			.select()
			.from(githubRepos)
			.where(eq(githubRepos.id, build.githubRepoId))
			.then((r) => r[0]);

		if (!githubRepo) {
			return NextResponse.json(
				{ error: "GitHub repo not found" },
				{ status: 404 },
			);
		}

		const installation = await db
			.select()
			.from(githubInstallations)
			.where(eq(githubInstallations.installationId, githubRepo.installationId))
			.then((r) => r[0]);

		if (!installation) {
			return NextResponse.json(
				{ error: "GitHub installation not found" },
				{ status: 404 },
			);
		}

		let installationToken: string;
		try {
			installationToken = await getInstallationToken(
				installation.installationId,
			);
		} catch (error) {
			console.error("[build:claim] failed to get installation token:", error);
			await db
				.update(builds)
				.set({
					status: "failed",
					error: "Failed to get GitHub installation token",
				})
				.where(eq(builds.id, buildId));
			return NextResponse.json(
				{ error: "Failed to get GitHub installation token" },
				{ status: 500 },
			);
		}

		cloneUrl = buildCloneUrl(installationToken, githubRepo.repoFullName);
	} else {
		return NextResponse.json(
			{ error: "No repository configured" },
			{ status: 400 },
		);
	}

	const serviceSecrets = await db
		.select()
		.from(secrets)
		.where(eq(secrets.serviceId, service.id));

	const secretsMap: Record<string, string> = {};
	for (const secret of serviceSecrets) {
		secretsMap[secret.key] = secret.encryptedValue;
	}

	console.log(
		`[build:claim] build ${buildId.slice(0, 8)} claimed by ${serverId.slice(0, 8)}, image: ${imageUri}, secrets: ${Object.keys(secretsMap).length}`,
	);

	return NextResponse.json({
		build: {
			id: build.id,
			commitSha: build.commitSha,
			commitMessage: build.commitMessage,
			branch: build.branch,
			serviceId: build.serviceId,
			projectId: project.id,
		},
		cloneUrl,
		imageUri,
		secrets: secretsMap,
	});
}
