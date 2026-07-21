import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
	builds,
	githubInstallations,
	githubRepos,
	services,
} from "@/db/schema";
import {
	createGitHubDeployment,
	updateGitHubDeploymentStatus,
	verifyWebhookSignature,
} from "@/lib/github";
import { triggerResolvedBuildInternal } from "@/lib/trigger-build";

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
	sender: { id: number; login: string };
};

type PushResult = {
	serviceId: string;
	status: "queued" | "skipped" | "failed";
	reason?: string;
	buildId?: string;
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

	const linkedServices = await db
		.select({ githubRepo: githubRepos, service: services })
		.from(githubRepos)
		.innerJoin(services, eq(githubRepos.serviceId, services.id))
		.where(eq(githubRepos.repoId, repository.id));

	if (linkedServices.length === 0) {
		return NextResponse.json({
			ok: true,
			skipped: true,
			reason: "repo not linked",
		});
	}

	const results: PushResult[] = [];

	for (const { githubRepo, service } of linkedServices) {
		if (service.deletedAt) {
			results.push({
				serviceId: service.id,
				status: "skipped",
				reason: "service deleted",
			});
			continue;
		}

		if (service.sourceType !== "github") {
			results.push({
				serviceId: service.id,
				status: "skipped",
				reason: "service not connected to GitHub",
			});
			continue;
		}

		if (!githubRepo.autoDeploy) {
			results.push({
				serviceId: service.id,
				status: "skipped",
				reason: "auto-deploy disabled",
			});
			continue;
		}

		const deployBranch = githubRepo.deployBranch || githubRepo.defaultBranch;
		if (branch !== deployBranch) {
			results.push({
				serviceId: service.id,
				status: "skipped",
				reason: `branch mismatch: ${branch} != ${deployBranch}`,
			});
			continue;
		}

		try {
			const existingBuild = await db
				.select()
				.from(builds)
				.where(
					and(
						eq(builds.serviceId, service.id),
						eq(builds.commitSha, head_commit.id),
					),
				)
				.then((r) => r[0]);

			if (existingBuild) {
				results.push({
					serviceId: service.id,
					status: "skipped",
					reason: "build already exists for this commit",
					buildId: existingBuild.id,
				});
				continue;
			}

			let githubDeploymentId: number | undefined;
			try {
				githubDeploymentId = await createGitHubDeployment(
					githubRepo.installationId,
					repository.full_name,
					head_commit.id,
					`${service.name}-${service.id}`,
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
				console.error(
					`[webhook:push] failed to create GitHub deployment for service ${service.id}:`,
					error,
				);
			}

			await triggerResolvedBuildInternal(service.id, {
				trigger: "push",
				commitSha: head_commit.id,
				commitMessage: head_commit.message,
				author: head_commit.author.username || head_commit.author.name,
				expectedRepository: `https://github.com/${repository.full_name}`,
				expectedBranch: branch,
				githubDeploymentId,
				idempotencyKey: `github-push:${githubRepo.id}:${head_commit.id}`,
				actor: {
					type: "github",
					githubUserId: payload.sender.id,
					login: payload.sender.login,
				},
			});

			results.push({ serviceId: service.id, status: "queued" });
		} catch (error) {
			console.error(
				`[webhook:push] failed to queue build for service ${service.id}:`,
				error,
			);
			results.push({
				serviceId: service.id,
				status: "failed",
				reason: "failed to queue build",
			});
		}
	}

	const hasFailures = results.some((result) => result.status === "failed");
	// Keep dispatch failures visible for manual redelivery. Deterministic event IDs
	// prevent already queued service links from starting duplicate builds.
	return NextResponse.json(
		{ ok: !hasFailures, results },
		{ status: hasFailures ? 500 : 200 },
	);
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
