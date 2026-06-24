"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { services } from "@/db/schema";
import { requireAuth } from "@/lib/auth";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { startMigrationInternal } from "@/lib/migrations";

export async function startMigration(
	serviceId: string,
	targetServerId: string,
) {
	await requireAuth();
	await startMigrationInternal(serviceId, targetServerId);
	revalidatePath(`/dashboard/projects`);
	return { success: true };
}

export async function cancelMigration(serviceId: string) {
	await requireAuth();
	await inngest.send(inngestEvents.migrationCancelled.create({ serviceId }));

	await db
		.update(services)
		.set({
			migrationStatus: null,
			migrationTargetServerId: null,
			migrationBackupId: null,
			migrationError: null,
		})
		.where(eq(services.id, serviceId));

	revalidatePath(`/dashboard/projects`);
	return { success: true };
}
