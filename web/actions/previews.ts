"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { getService } from "@/db/queries";
import { githubRepos, services } from "@/db/schema";
import { requireDeveloperRole } from "@/lib/auth";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import {
	ensurePreviewEnvironment,
	requirePreviewDomain,
} from "@/lib/preview-deployments";

export async function setPreviewDeploymentsEnabled(
	serviceId: string,
	enabled: boolean,
) {
	await requireDeveloperRole();
	const service = await getService(serviceId);
	if (!service) throw new Error("Service not found");
	if (service.previewOfService) {
		throw new Error("Preview services cannot create nested previews");
	}
	if (service.sourceType !== "github") {
		throw new Error("Preview deployments require a GitHub App service");
	}
	if (service.stateful) {
		throw new Error(
			"Preview deployments are available only for stateless services",
		);
	}
	if (enabled) {
		await requirePreviewDomain();
		await ensurePreviewEnvironment(service.projectId);
	}

	await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${serviceId}))`);
		const current = await tx
			.select({
				previewOfService: services.previewOfService,
				sourceType: services.sourceType,
				stateful: services.stateful,
			})
			.from(services)
			.where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
			.then((rows) => rows[0]);
		if (!current) throw new Error("Service not found");
		if (current.previewOfService) {
			throw new Error("Preview services cannot create nested previews");
		}
		if (current.sourceType !== "github") {
			throw new Error("Preview deployments require a GitHub App service");
		}
		if (current.stateful) {
			throw new Error(
				"Preview deployments are available only for stateless services",
			);
		}
		const repo = await tx
			.select({ id: githubRepos.id })
			.from(githubRepos)
			.where(eq(githubRepos.serviceId, serviceId))
			.then((rows) => rows[0]);
		if (!repo) {
			throw new Error("Preview deployments require a GitHub App service");
		}
		await tx
			.update(services)
			.set({ previewDeploymentsEnabled: enabled })
			.where(eq(services.id, serviceId));
	});
	await inngest.send(
		inngestEvents.previewServiceReconcileRequested.create(
			{ baseServiceId: serviceId },
			{ id: `preview-setting:${serviceId}:${enabled}:${randomUUID()}` },
		),
	);
	return { success: true };
}
