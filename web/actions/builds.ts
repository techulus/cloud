"use server";

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { builds, githubRepos, services } from "@/db/schema";
import { requireDeveloperRole } from "@/lib/auth";
import { getGitHubCommit, isFullCommitSha } from "@/lib/github";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";

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

	await db
		.update(builds)
		.set({ status: "cancelled", completedAt: new Date() })
		.where(eq(builds.id, buildId));

	await inngest.send(
		inngestEvents.buildCancelled.create({
			buildId,
			buildGroupId: build.buildGroupId,
		}),
	);

	return { success: true };
}

export async function retryBuild(buildId: string) {
	await requireDeveloperRole();
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

	await inngest.send(
		inngestEvents.buildTrigger.create({
			serviceId: build.serviceId,
			trigger: "manual",
			githubRepoId: build.githubRepoId ?? undefined,
			commitSha: build.commitSha,
			commitMessage: build.commitMessage ?? "Retry build",
			branch: build.branch,
			author: build.author ?? undefined,
		}),
	);

	return { success: true };
}

export async function triggerBuild(
	serviceId: string,
	trigger: "manual" | "scheduled" = "manual",
) {
	await requireDeveloperRole();
	const [service] = await db
		.select()
		.from(services)
		.where(and(eq(services.id, serviceId), isNull(services.deletedAt)));

	if (!service) {
		throw new Error("Service not found");
	}

	if (service.sourceType !== "github") {
		throw new Error("Service is not connected to GitHub");
	}

	const triggerMessage =
		trigger === "scheduled"
			? "Scheduled build trigger"
			: "Manual build trigger";

	const [githubRepo] = await db
		.select()
		.from(githubRepos)
		.where(eq(githubRepos.serviceId, serviceId));

	if (githubRepo) {
		await inngest.send(
			inngestEvents.buildTrigger.create({
				serviceId,
				trigger,
				githubRepoId: githubRepo.id,
				commitSha: "HEAD",
				commitMessage: triggerMessage,
				branch: githubRepo.deployBranch || githubRepo.defaultBranch || "main",
			}),
		);

		return { success: true };
	}

	if (!service.githubRepoUrl) {
		throw new Error("No GitHub repository linked to this service");
	}

	await inngest.send(
		inngestEvents.buildTrigger.create({
			serviceId,
			trigger,
			commitSha: "HEAD",
			commitMessage: triggerMessage,
			branch: service.githubBranch || "main",
		}),
	);

	return { success: true };
}

export async function triggerManualBuild(serviceId: string, commitSha: string) {
	await requireDeveloperRole();
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

	const commit = await getGitHubCommit(
		result.githubRepo.installationId,
		result.githubRepo.repoFullName,
		canonicalSha,
	);
	if (commit.sha.toLowerCase() !== canonicalSha) {
		throw new Error("GitHub returned an unexpected commit SHA");
	}
	await inngest.send(
		inngestEvents.buildTrigger.create({
			serviceId,
			trigger: "manual",
			githubRepoId: result.githubRepo.id,
			commitSha: commit.sha.toLowerCase(),
			commitMessage: commit.message.substring(0, 500),
			branch:
				result.githubRepo.deployBranch ||
				result.githubRepo.defaultBranch ||
				"main",
			author: commit.author ?? undefined,
		}),
	);

	return { success: true };
}
