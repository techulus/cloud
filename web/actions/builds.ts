"use server";

import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { builds, githubRepos, services } from "@/db/schema";
import {
	selectBuildServerForPlatform,
	getTargetPlatformsForService,
} from "@/lib/build-assignment";
import { enqueueWork } from "@/lib/work-queue";
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

	const targetPlatforms = await getTargetPlatformsForService(build.serviceId);
	const buildGroupId = randomUUID();
	const buildIds: string[] = [];

	for (const platform of targetPlatforms) {
		const newBuildId = randomUUID();
		buildIds.push(newBuildId);

		await db.insert(builds).values({
			id: newBuildId,
			githubRepoId: build.githubRepoId,
			serviceId: build.serviceId,
			commitSha: build.commitSha,
			commitMessage: build.commitMessage,
			branch: build.branch,
			author: build.author,
			targetPlatform: platform,
			buildGroupId,
			status: "pending",
		});

		const serverId = await selectBuildServerForPlatform(
			build.serviceId,
			platform,
		);
		await enqueueWork(serverId, "build", { buildId: newBuildId });
	}

	return { success: true, buildId: buildIds[0] };
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

		const pendingBuild = await db
			.select()
			.from(builds)
			.where(and(eq(builds.serviceId, serviceId), eq(builds.status, "pending")))
			.then((r) => r[0]);

		if (pendingBuild) {
			throw new Error("A build is already pending");
		}

		const triggerMessage =
			trigger === "scheduled"
				? "Scheduled build trigger"
				: "Manual build trigger";

		const targetPlatforms = await getTargetPlatformsForService(serviceId);
		const buildGroupId = randomUUID();
		const buildIds: string[] = [];

		for (const platform of targetPlatforms) {
			const buildId = randomUUID();
			buildIds.push(buildId);

			await db.insert(builds).values({
				id: buildId,
				githubRepoId: githubRepo.id,
				serviceId,
				commitSha: latestBuild?.commitSha || "HEAD",
				commitMessage: latestBuild?.commitMessage || triggerMessage,
				branch: latestBuild?.branch || githubRepo.deployBranch || "main",
				author: latestBuild?.author,
				targetPlatform: platform,
				buildGroupId,
				status: "pending",
			});

			const serverId = await selectBuildServerForPlatform(serviceId, platform);
			await enqueueWork(serverId, "build", { buildId });
		}

		await inngest.send({
			name: "build/started",
			data: {
				buildId: buildIds[0],
				serviceId,
				buildGroupId,
			},
		});

		return { success: true, buildId: buildIds[0] };
	}

	if (!service.githubRepoUrl) {
		throw new Error("No GitHub repository linked to this service");
	}

	const pendingBuild = await db
		.select()
		.from(builds)
		.where(and(eq(builds.serviceId, serviceId), eq(builds.status, "pending")))
		.then((r) => r[0]);

	if (pendingBuild) {
		throw new Error("A build is already pending");
	}

	const triggerMessage =
		trigger === "scheduled"
			? "Scheduled build trigger"
			: "Manual build trigger";

	const targetPlatforms = await getTargetPlatformsForService(serviceId);
	const buildGroupId = randomUUID();
	const buildIds: string[] = [];

	for (const platform of targetPlatforms) {
		const buildId = randomUUID();
		buildIds.push(buildId);

		await db.insert(builds).values({
			id: buildId,
			serviceId,
			commitSha: "HEAD",
			commitMessage: triggerMessage,
			branch: service.githubBranch || "main",
			targetPlatform: platform,
			buildGroupId,
			status: "pending",
		});

		const serverId = await selectBuildServerForPlatform(serviceId, platform);
		await enqueueWork(serverId, "build", { buildId });
	}

	await inngest.send({
		name: "build/started",
		data: {
			buildId: buildIds[0],
			serviceId,
			buildGroupId,
		},
	});

	return { success: true, buildId: buildIds[0] };
}
