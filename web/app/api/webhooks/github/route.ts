import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
	builds,
	environments,
	githubInstallations,
	githubRepos,
	projects,
	services,
} from "@/db/schema";
import {
	createGitHubDeployment,
	updateGitHubDeploymentStatus,
	verifyWebhookSignature,
} from "@/lib/github";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { deletePreviewsForGitHubInstallation } from "@/lib/preview-lifecycle";
import { pullRequestMergeRef } from "@/lib/service-revision-spec";
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

type PullRequestPayload = {
	action: string;
	number: number;
	pull_request: {
		draft: boolean;
		merged: boolean;
		base: { ref: string; repo: { id: number; full_name: string } };
		head: { repo: { id: number; full_name: string } | null };
	};
	repository: { id: number; full_name: string };
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
		await deletePreviewsForGitHubInstallation(
			installation.id,
			"GitHub installation deleted",
			{ removeRepositoryLinks: true },
		);
		await db
			.delete(githubInstallations)
			.where(eq(githubInstallations.installationId, installation.id));

		return NextResponse.json({ ok: true, message: "Installation deleted" });
	}

	if (action === "suspend") {
		await deletePreviewsForGitHubInstallation(
			installation.id,
			"GitHub installation suspended",
		);
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
		.select({
			githubRepo: githubRepos,
			service: services,
			project: projects,
			environment: environments,
		})
		.from(githubRepos)
		.innerJoin(services, eq(githubRepos.serviceId, services.id))
		.innerJoin(projects, eq(services.projectId, projects.id))
		.innerJoin(environments, eq(services.environmentId, environments.id))
		.where(eq(githubRepos.repoId, repository.id));

	if (linkedServices.length === 0) {
		return NextResponse.json({
			ok: true,
			skipped: true,
			reason: "repo not linked",
		});
	}

	const results: PushResult[] = [];

	for (const { githubRepo, service, project, environment } of linkedServices) {
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
				const baseUrl = process.env.APP_URL || "https://cloud.techulus.com";
				const serviceUrl = `${baseUrl}/dashboard/projects/${project.slug}/${environment.name}/services/${service.id}`;
				githubDeploymentId = await createGitHubDeployment(
					githubRepo.installationId,
					repository.full_name,
					head_commit.id,
					`${project.slug} / ${environment.name} / ${service.name}`,
					`Build ${head_commit.id.slice(0, 7)}: ${head_commit.message.substring(0, 100)}`,
				);

				await updateGitHubDeploymentStatus(
					githubRepo.installationId,
					repository.full_name,
					githubDeploymentId,
					"pending",
					{ description: "Build queued", environmentUrl: serviceUrl },
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

const pullRequestSyncActions = new Set([
	"opened",
	"reopened",
	"synchronize",
	"ready_for_review",
	"edited",
]);
const pullRequestCloseActions = new Set(["closed", "converted_to_draft"]);

async function handlePullRequestEvent(
	payload: PullRequestPayload,
	deliveryId: string,
) {
	if (
		!pullRequestSyncActions.has(payload.action) &&
		!pullRequestCloseActions.has(payload.action)
	) {
		return NextResponse.json({ ok: true, skipped: true });
	}
	if (
		!Number.isSafeInteger(payload.number) ||
		payload.number <= 0 ||
		payload.repository.id !== payload.pull_request.base.repo.id
	) {
		return NextResponse.json(
			{ error: "Invalid pull request payload" },
			{ status: 400 },
		);
	}

	const linkedServices = await db
		.select({ githubRepo: githubRepos, service: services })
		.from(githubRepos)
		.innerJoin(services, eq(githubRepos.serviceId, services.id))
		.where(eq(githubRepos.repoId, payload.repository.id));
	const sameRepository =
		payload.pull_request.head.repo?.id === payload.pull_request.base.repo.id;
	const shouldSync =
		pullRequestSyncActions.has(payload.action) &&
		!payload.pull_request.draft &&
		sameRepository;
	const previewGitRef = pullRequestMergeRef(payload.number);
	const events: Array<
		| ReturnType<typeof inngestEvents.previewSyncRequested.create>
		| ReturnType<typeof inngestEvents.previewCloseRequested.create>
	> = [];
	const syncedBaseServiceIds = new Set<string>();
	const linkedBaseServices = linkedServices.filter(
		({ service }) => !service.previewOfService && !service.deletedAt,
	);

	if (shouldSync) {
		for (const { githubRepo, service } of linkedServices) {
			if (
				service.previewOfService ||
				service.deletedAt ||
				service.sourceType !== "github" ||
				service.stateful ||
				!service.previewDeploymentsEnabled ||
				(githubRepo.deployBranch ?? githubRepo.defaultBranch) !==
					payload.pull_request.base.ref
			) {
				continue;
			}
			syncedBaseServiceIds.add(service.id);
			events.push(
				inngestEvents.previewSyncRequested.create(
					{
						baseServiceId: service.id,
						previewGitRef,
					},
					{
						id: `github-pr-sync:${deliveryId}:${service.id}:${payload.number}`,
					},
				),
			);
		}
	}

	for (const { service } of linkedBaseServices) {
		if (syncedBaseServiceIds.has(service.id)) {
			continue;
		}
		const reason =
			payload.action === "closed"
				? payload.pull_request.merged
					? "pull_request_merged"
					: "pull_request_closed"
				: payload.action === "converted_to_draft"
					? "converted_to_draft"
					: !sameRepository
						? "fork_pull_request"
						: "pull_request_ineligible";
		events.push(
			inngestEvents.previewCloseRequested.create(
				{
					baseServiceId: service.id,
					previewGitRef,
					reason,
					verifyWithGitHub: true,
				},
				{
					id: `github-pr-close:${deliveryId}:${service.id}:${payload.number}`,
				},
			),
		);
	}

	if (events.length > 0) {
		try {
			await inngest.send(events);
		} catch (error) {
			console.error("Failed to dispatch preview deployment events:", error);
			return NextResponse.json(
				{ ok: false, error: "Failed to queue preview deployment work" },
				{ status: 500 },
			);
		}
	}
	return NextResponse.json({
		ok: true,
		queued: events.length,
		skippedFork: !sameRepository,
	});
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
		case "pull_request": {
			const deliveryId =
				request.headers.get("x-github-delivery") ??
				createHash("sha256").update(body).digest("hex");
			return handlePullRequestEvent(payload as PullRequestPayload, deliveryId);
		}
		case "ping":
			return NextResponse.json({ ok: true, message: "pong" });
		default:
			return NextResponse.json({
				ok: true,
				message: `Ignored event: ${event}`,
			});
	}
}
