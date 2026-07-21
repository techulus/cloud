"use server";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { builds, githubRepos, services } from "@/db/schema";
import { requireDeveloperRole } from "@/lib/auth";
import { isFullCommitSha, listGitHubCommits } from "@/lib/github";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import {
	requeueBuildRevisionInternal,
	triggerBuildInternal,
	triggerResolvedBuildInternal,
} from "@/lib/trigger-build";

export async function cancelBuild(buildId: string) {
	await requireDeveloperRole();
	const [build] = await db.select().from(builds).where(eq(builds.id, buildId));

	if (!build) {
		throw new Error("Build not found");
	}

	const cancellableStatuses = [
		"pending",
		"claimed",
		"cloning",
		"building",
		"pushing",
	];
	if (!cancellableStatuses.includes(build.status)) {
		throw new Error(`Cannot cancel build in ${build.status} status`);
	}

	const cancelled = await db
		.update(builds)
		.set({ status: "cancelled", completedAt: new Date() })
		.where(
			and(
				eq(builds.id, buildId),
				inArray(builds.status, [
					"pending",
					"claimed",
					"cloning",
					"building",
					"pushing",
				]),
			),
		)
		.returning({ id: builds.id })
		.then((rows) => rows[0]);
	if (!cancelled) {
		const current = await db
			.select({ status: builds.status })
			.from(builds)
			.where(eq(builds.id, buildId))
			.then((rows) => rows[0]);
		if (!current) throw new Error("Build not found");
		throw new Error(`Cannot cancel build in ${current.status} status`);
	}

	await inngest.send(
		inngestEvents.buildCancelled.create(
			{
				buildId,
				buildGroupId: build.buildGroupId,
			},
			{
				id: `build-cancelled-${buildId}`,
			},
		),
	);

	return { success: true };
}

export async function retryBuild(buildId: string) {
	const session = await requireDeveloperRole();
	if (!session) throw new Error("Unauthorized");
	const [build] = await db.select().from(builds).where(eq(builds.id, buildId));

	if (!build) {
		throw new Error("Build not found");
	}

	const [service] = await db
		.select({ id: services.id })
		.from(services)
		.where(and(eq(services.id, build.serviceId), isNull(services.deletedAt)));

	if (!service) {
		throw new Error("Service not found");
	}

	if (build.status !== "failed" && build.status !== "cancelled") {
		throw new Error(`Cannot retry build in ${build.status} status`);
	}

	await requeueBuildRevisionInternal({
		serviceId: build.serviceId,
		serviceRevisionId: build.serviceRevisionId,
		commitMessage: build.commitMessage ?? "Retry build",
		author: build.author ?? undefined,
		actor: {
			type: "user",
			userId: session.user.id,
			name: session.user.name,
		},
	});

	return { success: true };
}

export async function triggerBuild(
	serviceId: string,
	trigger: "manual" | "scheduled" = "manual",
) {
	const session = await requireDeveloperRole();
	const actor = session
		? {
				type: "user" as const,
				userId: session.user.id,
				name: session.user.name,
			}
		: ({ type: "system" } as const);
	await triggerBuildInternal(serviceId, trigger, actor);
	return { success: true };
}

export async function triggerManualBuild(serviceId: string, commitSha: string) {
	const session = await requireDeveloperRole();
	if (!session) throw new Error("Unauthorized");
	if (!isFullCommitSha(commitSha)) {
		throw new Error("Commit SHA must be a full 40-character hexadecimal SHA");
	}

	const canonicalSha = commitSha.toLowerCase();
	const [result] = await db
		.select({ service: services, githubRepo: githubRepos })
		.from(services)
		.innerJoin(githubRepos, eq(githubRepos.serviceId, services.id))
		.where(and(eq(services.id, serviceId), isNull(services.deletedAt)));
	if (!result) throw new Error("Active GitHub App-connected service not found");
	if (result.service.sourceType !== "github") {
		throw new Error("Service is not connected to GitHub");
	}

	const branch =
		result.githubRepo.deployBranch || result.githubRepo.defaultBranch || "main";
	const commits = await listGitHubCommits(
		result.githubRepo.installationId,
		result.githubRepo.repoFullName,
		branch,
	);
	const commit = commits.find(
		(candidate) => candidate.sha.toLowerCase() === canonicalSha,
	);
	if (!commit) {
		throw new Error(
			"Selected commit is no longer among the latest 50 commits on the source branch",
		);
	}

	await triggerResolvedBuildInternal(serviceId, {
		trigger: "manual",
		commitSha: commit.sha,
		commitMessage: commit.message,
		author: commit.author ?? undefined,
		expectedRepository: `https://github.com/${result.githubRepo.repoFullName}`,
		expectedBranch: branch,
		actor: {
			type: "user",
			userId: session.user.id,
			name: session.user.name,
		},
	});

	return { success: true };
}
