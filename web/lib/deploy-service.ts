import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { getService } from "@/db/queries";
import { rollouts, serviceReplicas } from "@/db/schema";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { startMigrationInternal } from "@/lib/migrations";

export async function deployServiceInternal(serviceId: string) {
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
			await startMigrationInternal(serviceId, targetServerId);
			revalidatePath(`/dashboard/projects`);
			return { migrationStarted: true };
		}
	}

	const rolloutId = randomUUID();

	await db.insert(rollouts).values({
		id: rolloutId,
		serviceId,
		status: "queued",
		currentStage: "queued",
	});

	try {
		await inngest.send(
			inngestEvents.rolloutCreated.create({
				rolloutId,
				serviceId,
			}),
		);
	} catch (error) {
		await db
			.update(rollouts)
			.set({
				status: "failed",
				currentStage: "enqueue_failed",
				completedAt: new Date(),
			})
			.where(eq(rollouts.id, rolloutId));
		throw error;
	}

	return { rolloutId };
}
