import { and, eq, inArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { getSetting } from "@/db/queries";
import { builds, serviceRevisions, services } from "@/db/schema";
import { verifyAgentRequest } from "@/lib/agent-auth";
import { cloneUrlForRevisionSource } from "@/lib/build-revision-source";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { parseServiceRevisionSpec } from "@/lib/service-revision-changes";
import {
	DEFAULT_BUILD_TIMEOUT_MINUTES,
	SETTING_KEYS,
} from "@/lib/settings-keys";

function imageRepository(image: string): string {
	const digestIndex = image.indexOf("@");
	if (digestIndex > 0) return image.slice(0, digestIndex);
	const lastColon = image.lastIndexOf(":");
	return lastColon > image.lastIndexOf("/") ? image.slice(0, lastColon) : image;
}

export async function POST(
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
		.update(builds)
		.set({
			status: "claimed",
			claimedBy: serverId,
			claimedAt: new Date(),
		})
		.where(and(eq(builds.id, buildId), eq(builds.status, "pending")))
		.returning()
		.then((rows) => rows[0]);

	if (!build) {
		return NextResponse.json(
			{ error: "Build not found or already claimed" },
			{ status: 409 },
		);
	}

	const failClaim = async (message: string, status = 500) => {
		const failed = await db
			.update(builds)
			.set({ status: "failed", error: message, completedAt: new Date() })
			.where(
				and(
					eq(builds.id, buildId),
					eq(builds.claimedBy, serverId),
					inArray(builds.status, ["claimed", "cloning", "building", "pushing"]),
				),
			)
			.returning({ id: builds.id })
			.then((rows) => rows[0]);
		if (!failed) {
			return NextResponse.json(
				{ error: "Build was cancelled while being claimed" },
				{ status: 409 },
			);
		}
		await inngest.send(
			inngestEvents.buildCompleted.create(
				{
					buildId,
					serviceId: build.serviceId,
					serviceRevisionId: build.serviceRevisionId,
					buildGroupId: build.buildGroupId,
					status: "failed",
					error: message,
				},
				{
					id: `build-completed-${buildId}`,
				},
			),
		);
		return NextResponse.json({ error: message }, { status });
	};

	const [service, revision, buildTimeoutMinutes] = await Promise.all([
		db
			.select({ id: services.id, projectId: services.projectId })
			.from(services)
			.where(eq(services.id, build.serviceId))
			.then((rows) => rows[0]),
		db
			.select({ specification: serviceRevisions.specification })
			.from(serviceRevisions)
			.where(
				and(
					eq(serviceRevisions.id, build.serviceRevisionId),
					eq(serviceRevisions.serviceId, build.serviceId),
				),
			)
			.then((rows) => rows[0]),
		getSetting<number>(SETTING_KEYS.BUILD_TIMEOUT_MINUTES),
	]);
	if (!service) return failClaim("Service not found", 404);
	if (!revision) return failClaim("Build service revision not found", 404);

	let specification: ReturnType<typeof parseServiceRevisionSpec>;
	try {
		specification = parseServiceRevisionSpec(revision.specification);
	} catch (error) {
		console.error("[build:get] invalid service revision:", error);
		return failClaim("Invalid build service revision");
	}
	if (
		specification.source.type !== "github" ||
		specification.source.commitSha !== build.commitSha ||
		specification.source.branch !== build.branch
	) {
		return failClaim("Build metadata does not match its service revision");
	}

	let cloneUrl: string;
	try {
		cloneUrl = await cloneUrlForRevisionSource(specification.source);
	} catch (error) {
		console.error("[build:get] failed to get installation token:", error);
		return failClaim("Failed to get GitHub installation token");
	}

	const secretsMap = Object.fromEntries(
		specification.secrets.map((secret) => [secret.key, secret.encryptedValue]),
	);
	const targetPlatforms = [build.targetPlatform];

	console.log(
		`[build:get] build ${buildId.slice(0, 8)} details fetched by ${serverId.slice(0, 8)}, revision: ${build.serviceRevisionId.slice(0, 8)}, image: ${specification.image}`,
	);

	return NextResponse.json({
		build: {
			id: build.id,
			commitSha: specification.source.commitSha,
			commitMessage: build.commitMessage,
			branch: specification.source.branch,
			serviceId: build.serviceId,
			projectId: service.projectId,
		},
		cloneUrl,
		imageRepository: imageRepository(specification.image),
		imageUri: specification.image,
		rootDir: specification.source.rootDir ?? "",
		secrets: secretsMap,
		timeoutMinutes: buildTimeoutMinutes ?? DEFAULT_BUILD_TIMEOUT_MINUTES,
		targetPlatforms,
	});
}
