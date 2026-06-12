import { and, eq, isNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { getSetting } from "@/db/queries";
import {
	builds,
	githubInstallations,
	githubRepos,
	projects,
	secrets,
	services,
} from "@/db/schema";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { buildCloneUrl, getInstallationToken } from "@/lib/github";
import {
	DEFAULT_BUILD_TIMEOUT_MINUTES,
	SETTING_KEYS,
} from "@/lib/settings-keys";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await verifyAgentRequest(request);
	if (!auth.success) {
		return NextResponse.json({ error: auth.error }, { status: auth.status });
	}

	const { id: buildId } = await params;
	const { serverId } = auth;

	const claimResult = await db
		.update(builds)
		.set({
			status: "claimed",
			claimedBy: serverId,
			claimedAt: new Date(),
		})
		.where(and(eq(builds.id, buildId), eq(builds.status, "pending")))
		.returning();

	const build = claimResult[0];

	if (!build) {
		return NextResponse.json(
			{ error: "Build not found or already claimed" },
			{ status: 409 },
		);
	}

	const service = await db
		.select()
		.from(services)
		.where(and(eq(services.id, build.serviceId), isNull(services.deletedAt)))
		.then((r) => r[0]);

	if (!service) {
		await db
			.update(builds)
			.set({
				status: "failed",
				error: "Service not found",
				completedAt: new Date(),
			})
			.where(eq(builds.id, buildId));
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
	const imageRepository = `${registryHost}/${project.id}/${service.id}`;
	const commitSha = build.commitSha === "HEAD" ? "latest" : build.commitSha;
	const imageUri = `${imageRepository}:${commitSha}`;

	let cloneUrl: string;

	if (build.githubRepoId) {
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
			console.error("[build:get] failed to get installation token:", error);
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
	} else if (service.githubRepoUrl) {
		cloneUrl = service.githubRepoUrl;
		if (!cloneUrl.endsWith(".git")) {
			cloneUrl = `${cloneUrl}.git`;
		}
	} else {
		return NextResponse.json(
			{ error: "No repository configured" },
			{ status: 400 },
		);
	}

	const [serviceSecrets, buildTimeoutMinutes] = await Promise.all([
		db.select().from(secrets).where(eq(secrets.serviceId, service.id)),
		getSetting<number>(SETTING_KEYS.BUILD_TIMEOUT_MINUTES),
	]);

	const secretsMap: Record<string, string> = {};
	for (const secret of serviceSecrets) {
		secretsMap[secret.key] = secret.encryptedValue;
	}

	const targetPlatforms = build.targetPlatform
		? [build.targetPlatform]
		: ["linux/amd64"];

	console.log(
		`[build:get] build ${buildId.slice(0, 8)} details fetched by ${serverId.slice(0, 8)}, image: ${imageUri}`,
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
		imageRepository,
		imageUri,
		rootDir: service.githubRootDir || "",
		secrets: secretsMap,
		timeoutMinutes: buildTimeoutMinutes ?? DEFAULT_BUILD_TIMEOUT_MINUTES,
		targetPlatforms,
	});
}
