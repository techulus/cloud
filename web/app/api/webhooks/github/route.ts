import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import {
	builds,
	githubInstallations,
	githubRepos,
	services,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import {
	verifyWebhookSignature,
	createGitHubDeployment,
	updateGitHubDeploymentStatus,
} from "@/lib/github";

type InstallationPayload = {
	action: "created" | "deleted" | "suspend" | "unsuspend";
	installation: {
		id: number;
		account: {
			login: string;
			type: "User" | "Organization";
		};
	};
	sender: {
		id: number;
		login: string;
	};
};

type PushPayload = {
	ref: string;
	repository: {
		id: number;
		full_name: string;
		default_branch: string;
	};
	head_commit: {
		id: string;
		message: string;
		author: {
			name: string;
			username?: string;
		};
	} | null;
	installation?: {
		id: number;
	};
};

async function handleInstallationEvent(payload: InstallationPayload) {
	const { action, installation } = payload;

	if (action === "created") {
		const existingInstallation = await db
			.select()
			.from(githubInstallations)
			.where(eq(githubInstallations.installationId, installation.id))
			.then((r) => r[0]);

		if (existingInstallation) {
			return NextResponse.json({
				ok: true,
				message: "Installation already exists",
			});
		}

		return NextResponse.json({
			ok: true,
			message: "Installation pending - user must complete setup in dashboard",
			installationId: installation.id,
		});
	}

	if (action === "deleted") {
		await db
			.delete(githubInstallations)
			.where(eq(githubInstallations.installationId, installation.id));

		return NextResponse.json({ ok: true, message: "Installation deleted" });
	}

	return NextResponse.json({ ok: true });
}

async function handlePushEvent(payload: PushPayload) {
	const { ref, repository, head_commit } = payload;

	if (!head_commit) {
		return NextResponse.json({
			ok: true,
			skipped: true,
			reason: "no head commit",
		});
	}

	const branch = ref.replace("refs/heads/", "");

	const githubRepo = await db
		.select()
		.from(githubRepos)
		.where(eq(githubRepos.repoId, repository.id))
		.then((r) => r[0]);

	if (!githubRepo) {
		return NextResponse.json({
			ok: true,
			skipped: true,
			reason: "repo not linked",
		});
	}

	if (!githubRepo.serviceId) {
		return NextResponse.json({
			ok: true,
			skipped: true,
			reason: "no service linked",
		});
	}

	if (!githubRepo.autoDeploy) {
		return NextResponse.json({
			ok: true,
			skipped: true,
			reason: "auto-deploy disabled",
		});
	}

	const deployBranch = githubRepo.deployBranch || githubRepo.defaultBranch;
	if (branch !== deployBranch) {
		return NextResponse.json({
			ok: true,
			skipped: true,
			reason: `branch mismatch: ${branch} != ${deployBranch}`,
		});
	}

	const service = await db
		.select()
		.from(services)
		.where(eq(services.id, githubRepo.serviceId))
		.then((r) => r[0]);

	if (!service) {
		return NextResponse.json({
			ok: true,
			skipped: true,
			reason: "service not found",
		});
	}

	const existingBuild = await db
		.select()
		.from(builds)
		.where(
			and(
				eq(builds.serviceId, githubRepo.serviceId),
				eq(builds.commitSha, head_commit.id),
			),
		)
		.then((r) => r[0]);

	if (existingBuild) {
		return NextResponse.json({
			ok: true,
			skipped: true,
			reason: "build already exists for this commit",
			buildId: existingBuild.id,
		});
	}

	const buildId = randomUUID();

	let githubDeploymentId: number | undefined;
	try {
		githubDeploymentId = await createGitHubDeployment(
			githubRepo.installationId,
			repository.full_name,
			head_commit.id,
			service.name,
			`Build ${head_commit.id.slice(0, 7)}: ${head_commit.message.substring(0, 100)}`,
		);

		await updateGitHubDeploymentStatus(
			githubRepo.installationId,
			repository.full_name,
			githubDeploymentId,
			"pending",
			{ description: "Build queued" },
		);
	} catch (error) {
		console.error("[webhook:push] failed to create GitHub deployment:", error);
	}

	await db.insert(builds).values({
		id: buildId,
		githubRepoId: githubRepo.id,
		serviceId: githubRepo.serviceId,
		commitSha: head_commit.id,
		commitMessage: head_commit.message.substring(0, 500),
		branch,
		author: head_commit.author.username || head_commit.author.name,
		status: "pending",
		githubDeploymentId,
	});

	console.log(
		`[webhook:push] created build ${buildId} for ${repository.full_name}@${head_commit.id.slice(0, 7)}`,
	);

	return NextResponse.json({ ok: true, buildId });
}

export async function POST(request: NextRequest) {
	const body = await request.text();
	const signature = request.headers.get("x-hub-signature-256");

	if (!verifyWebhookSignature(body, signature)) {
		console.error("[webhook:github] invalid signature");
		return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
	}

	const event = request.headers.get("x-github-event");
	const payload = JSON.parse(body);

	console.log(`[webhook:github] received event: ${event}`);

	switch (event) {
		case "installation":
			return handleInstallationEvent(payload as InstallationPayload);
		case "push":
			return handlePushEvent(payload as PushPayload);
		case "ping":
			return NextResponse.json({ ok: true, message: "pong" });
		default:
			return NextResponse.json({
				ok: true,
				message: `Ignored event: ${event}`,
			});
	}
}
