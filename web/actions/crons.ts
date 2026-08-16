"use server";

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { serviceCrons, services } from "@/db/schema";
import { requireDeveloperRole } from "@/lib/auth";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";

export async function runServiceCron(cronId: string) {
	await requireDeveloperRole();
	const cron = await db
		.select({ id: serviceCrons.id, schedule: serviceCrons.schedule })
		.from(serviceCrons)
		.innerJoin(
			services,
			and(
				eq(serviceCrons.serviceId, services.id),
				isNull(services.deletedAt),
				isNull(services.previewOfServiceId),
			),
		)
		.where(eq(serviceCrons.id, cronId))
		.limit(1)
		.then((rows) => rows[0]);
	if (!cron) throw new Error("Cron job not found");

	await inngest.send(
		inngestEvents.serviceCronExecute.create({
			cronId: cron.id,
			schedule: cron.schedule,
			scheduledFor: new Date().toISOString(),
			source: "manual",
		}),
	);

	return { success: true };
}
