"use server";

import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { builds, githubRepos, services } from "@/db/schema";
import { inngest } from "@/lib/inngest/client";

export async function cancelBuild(buildId: string) {
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

	await inngest.send({
		name: "build/cancelled",
		data: {
			buildId,
			buildGroupId: build.buildGroupId,
		},
	});

	return { success: true };
}

export async function retryBuild(buildId: string) {
	const [build] = await db.select().from(builds).where(eq(builds.id, buildId));

	if (!build) {
		throw new Error("Build not found");
	}

	if (build.status !== "failed" && build.status !== "cancelled") {
		throw new Error(`Cannot retry build in ${build.status} status`);
	}

	await inngest.send({
		name: "build/trigger",
		data: {
			serviceId: build.serviceId,
			trigger: "manual",
			githubRepoId: build.githubRepoId ?? undefined,
			commitSha: build.commitSha,
			commitMessage: build.commitMessage ?? "Retry build",
			branch: build.branch,
			author: build.author ?? undefined,
		},
	});

	return { success: true };
}

export async function triggerBuild(
	serviceId: string,
	trigger: "manual" | "scheduled" = "manual",
) {
	const [service] = await db
		.select()
		.from(services)
		.where(eq(services.id, serviceId));

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
		const [latestBuild] = await db
			.select()
			.from(builds)
			.where(eq(builds.serviceId, serviceId))
			.orderBy(desc(builds.createdAt))
			.limit(1);

		await inngest.send({
			name: "build/trigger",
			data: {
				serviceId,
				trigger,
				githubRepoId: githubRepo.id,
				commitSha: latestBuild?.commitSha || "HEAD",
				commitMessage: latestBuild?.commitMessage || triggerMessage,
				branch: latestBuild?.branch || githubRepo.deployBranch || "main",
				author: latestBuild?.author ?? undefined,
			},
		});

		return { success: true };
	}

	if (!service.githubRepoUrl) {
		throw new Error("No GitHub repository linked to this service");
	}

	await inngest.send({
		name: "build/trigger",
		data: {
			serviceId,
			trigger,
			commitSha: "HEAD",
			commitMessage: triggerMessage,
			branch: service.githubBranch || "main",
		},
	});

	return { success: true };
}
