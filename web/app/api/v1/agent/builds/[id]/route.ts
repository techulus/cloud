import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
	builds,
	githubRepos,
	githubInstallations,
	services,
	serviceReplicas,
	servers,
	projects,
	secrets,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { getInstallationToken, buildCloneUrl } from "@/lib/github";
import { getSetting } from "@/db/queries";
import {
	SETTING_KEYS,
	DEFAULT_BUILD_TIMEOUT_MINUTES,
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

	const build = await db
		.select()
		.from(builds)
		.where(eq(builds.id, buildId))
		.then((r) => r[0]);

	if (!build) {
		return NextResponse.json({ error: "Build not found" }, { status: 404 });
	}

	await db
		.update(builds)
		.set({
			status: "claimed",
			claimedBy: serverId,
			claimedAt: new Date(),
		})
		.where(eq(builds.id, buildId));

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
			cloneUrl = cloneUrl + ".git";
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

	const replicas = await db
		.select({ meta: servers.meta })
		.from(serviceReplicas)
		.innerJoin(servers, eq(serviceReplicas.serverId, servers.id))
		.where(eq(serviceReplicas.serviceId, service.id));

	const targetPlatforms = [
		...new Set(
			replicas
				.map((r) => r.meta?.arch)
				.filter((arch): arch is string => !!arch)
				.map((arch) => `linux/${arch}`),
		),
	];

	if (targetPlatforms.length === 0) {
		targetPlatforms.push("linux/amd64", "linux/arm64");
	}

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
		imageUri,
		rootDir: service.githubRootDir || "",
		secrets: secretsMap,
		timeoutMinutes: buildTimeoutMinutes ?? DEFAULT_BUILD_TIMEOUT_MINUTES,
		targetPlatforms,
	});
}
