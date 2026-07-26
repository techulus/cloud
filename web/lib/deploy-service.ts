import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { getService } from "@/db/queries";
import { serviceReplicas } from "@/db/schema";
import { startMigrationInternal } from "@/lib/migrations";
import { sendRolloutCreated } from "@/lib/rollout-enqueue";
import type { ServiceRevisionActor } from "@/lib/service-revision-actor";
import {
	createRolloutForServiceRevision,
	createRolloutWithServiceRevision,
} from "@/lib/service-revisions";
import { triggerBuildInternal } from "@/lib/trigger-build";

export async function deployServiceRevisionInternal(
	serviceId: string,
	serviceRevisionId: string,
	artifactImageUri: string,
) {
	const result = await createRolloutForServiceRevision(
		serviceId,
		serviceRevisionId,
		artifactImageUri,
	);
	if (!result.rolloutId) return result;

	await sendRolloutCreated(result.rolloutId, serviceId);

	return result;
}

export async function deployServiceInternal(
	serviceId: string,
	actor: ServiceRevisionActor | null,
	options: {
		runtimeBaseRevisionId?: string;
		githubTrigger?: "manual" | "scheduled";
	} = {},
) {
	const service = await getService(serviceId);
	if (!service) {
		throw new Error("Service not found");
	}

	if (service.stateful) {
		const configuredReplicas = await db
			.select({
				serverId: serviceReplicas.serverId,
				replicas: serviceReplicas.count,
			})
			.from(serviceReplicas)
			.where(eq(serviceReplicas.serviceId, serviceId));

		const placements = configuredReplicas.filter((p) => p.replicas > 0);
		const totalReplicas = placements.reduce((sum, p) => sum + p.replicas, 0);

		if (totalReplicas !== 1) {
			throw new Error("Stateful services can only have exactly 1 replica");
		}

		const serverIds = placements.map((p) => p.serverId);
		if (serverIds.length !== 1) {
			throw new Error(
				"Stateful services must be deployed to exactly one server",
			);
		}

		const targetServerId = serverIds[0];
		if (service.lockedServerId && service.lockedServerId !== targetServerId) {
			if (service.migrationStatus) {
				throw new Error("Migration already in progress");
			}
			await startMigrationInternal(serviceId, targetServerId, actor);
			revalidatePath(`/dashboard/projects`);
			return { migrationStarted: true };
		}
	}
	const runtimeBaseRevisionId =
		service.sourceType === "github" ? options.runtimeBaseRevisionId : undefined;
	if (service.sourceType === "github" && !runtimeBaseRevisionId) {
		if (!options.githubTrigger || !actor) {
			throw new Error("GitHub deployment requires a build trigger");
		}
		return triggerBuildInternal(serviceId, options.githubTrigger, actor);
	}

	const { rolloutId } = await createRolloutWithServiceRevision(
		serviceId,
		actor,
		runtimeBaseRevisionId,
	);

	await sendRolloutCreated(rolloutId, serviceId);

	return { rolloutId };
}
