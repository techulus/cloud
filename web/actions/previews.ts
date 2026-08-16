"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { getService } from "@/db/queries";
import { githubRepos, services } from "@/db/schema";
import { requireDeveloperRole } from "@/lib/auth";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { requirePreviewDomain } from "@/lib/preview-deployments";

export async function setPreviewDeploymentsEnabled(
	serviceId: string,
	enabled: boolean,
) {
	await requireDeveloperRole();
	const service = await getService(serviceId);
	if (!service) throw new Error("Service not found");
	if (service.sourceType !== "github") {
		throw new Error("Preview deployments require a GitHub App service");
	}
	if (service.stateful) {
		throw new Error(
			"Preview deployments are available only for stateless services",
		);
	}
	const repo = await db
		.select({ id: githubRepos.id })
		.from(githubRepos)
		.where(eq(githubRepos.serviceId, serviceId))
		.then((rows) => rows[0]);
	if (!repo)
		throw new Error("Preview deployments require a GitHub App service");
	if (enabled) await requirePreviewDomain();

	await db
		.update(services)
		.set({ previewDeploymentsEnabled: enabled })
		.where(
			and(
				eq(services.id, serviceId),
				isNull(services.deletedAt),
				isNull(services.previewOfServiceId),
			),
		);
	await inngest.send(
		inngestEvents.previewServiceReconcileRequested.create(
			{ baseServiceId: serviceId },
			{ id: `preview-setting:${serviceId}:${enabled}:${randomUUID()}` },
		),
	);
	return { success: true };
}

export async function redeployPreview(
	baseServiceId: string,
	pullRequestNumber: number,
) {
	await requireDeveloperRole();
	const service = await getService(baseServiceId);
	if (!service?.previewDeploymentsEnabled) {
		throw new Error("Preview deployments are not enabled for this service");
	}
	await inngest.send(
		inngestEvents.previewSyncRequested.create(
			{ baseServiceId, pullRequestNumber, force: true },
			{
				id: `preview-redeploy:${baseServiceId}:${pullRequestNumber}:${randomUUID()}`,
			},
		),
	);
	return { success: true };
}

export async function removePreview(
	baseServiceId: string,
	pullRequestNumber: number,
) {
	await requireDeveloperRole();
	const service = await getService(baseServiceId);
	if (!service) throw new Error("Service not found");
	await inngest.send(
		inngestEvents.previewCloseRequested.create(
			{
				baseServiceId,
				pullRequestNumber,
				reason: "removed manually",
			},
			{
				id: `preview-remove:${baseServiceId}:${pullRequestNumber}:${randomUUID()}`,
			},
		),
	);
	return { success: true };
}
