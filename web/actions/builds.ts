"use server";

import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { builds, githubRepos, services } from "@/db/schema";

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

	const newBuildId = randomUUID();

	await db.insert(builds).values({
		id: newBuildId,
		githubRepoId: build.githubRepoId,
		serviceId: build.serviceId,
		commitSha: build.commitSha,
		commitMessage: build.commitMessage,
		branch: build.branch,
		author: build.author,
		status: "pending",
	});

	return { success: true, buildId: newBuildId };
}

export async function triggerBuild(serviceId: string) {
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

	const newBuildId = randomUUID();

	if (service.githubRepoUrl) {
		const pendingBuild = await db
			.select()
			.from(builds)
			.where(and(eq(builds.serviceId, serviceId), eq(builds.status, "pending")))
			.then((r) => r[0]);

		if (pendingBuild) {
			throw new Error("A build is already pending");
		}

		await db.insert(builds).values({
			id: newBuildId,
			serviceId,
			commitSha: "HEAD",
			commitMessage: "Manual build trigger",
			branch: service.githubBranch || "main",
			status: "pending",
		});

		return { success: true, buildId: newBuildId };
	}

	const [githubRepo] = await db
		.select()
		.from(githubRepos)
		.where(eq(githubRepos.serviceId, serviceId));

	if (!githubRepo) {
		throw new Error("No GitHub repository linked to this service");
	}

	const [latestBuild] = await db
		.select()
		.from(builds)
		.where(eq(builds.serviceId, serviceId))
		.orderBy(desc(builds.createdAt))
		.limit(1);

	if (!latestBuild) {
		throw new Error(
			"No previous builds found. Push to the repository to trigger a build.",
		);
	}

	const pendingBuild = await db
		.select()
		.from(builds)
		.where(
			and(
				eq(builds.serviceId, serviceId),
				eq(builds.commitSha, latestBuild.commitSha),
				eq(builds.status, "pending"),
			),
		)
		.then((r) => r[0]);

	if (pendingBuild) {
		throw new Error("A build for this commit is already pending");
	}

	await db.insert(builds).values({
		id: newBuildId,
		githubRepoId: githubRepo.id,
		serviceId,
		commitSha: latestBuild.commitSha,
		commitMessage: latestBuild.commitMessage,
		branch: latestBuild.branch,
		author: latestBuild.author,
		status: "pending",
	});

	return { success: true, buildId: newBuildId };
}

export async function getBuilds(serviceId: string) {
	const buildsList = await db
		.select()
		.from(builds)
		.where(eq(builds.serviceId, serviceId))
		.orderBy(desc(builds.createdAt));

	return buildsList;
}

export async function getBuild(buildId: string) {
	const [build] = await db.select().from(builds).where(eq(builds.id, buildId));

	return build;
}
