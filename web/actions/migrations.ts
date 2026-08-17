"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { services } from "@/db/schema";
import { requireDeveloperRole } from "@/lib/auth";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";

export async function cancelMigration(serviceId: string) {
	await requireDeveloperRole();
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
