import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
	environments,
	notifications,
	projects,
	services,
	user,
} from "@/db/schema";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import type { NotificationEvent } from "@/lib/inngest/events/notification";

export async function notify(event: NotificationEvent) {
	return inngest.send(
		inngestEvents.notificationRequested.create(event, {
			id: `notification-${event.kind}-${event.occurrenceId}`,
		}),
	);
}

async function serviceContext(serviceId: string) {
	return db
		.select({
			serviceName: services.name,
			projectName: projects.name,
			projectSlug: projects.slug,
			environmentName: environments.name,
		})
		.from(services)
		.innerJoin(projects, eq(projects.id, services.projectId))
		.innerJoin(environments, eq(environments.id, services.environmentId))
		.where(eq(services.id, serviceId))
		.then((rows) => rows[0]);
}

export async function renderInAppNotification(event: NotificationEvent) {
	if (event.kind === "member.invited") return null;
	if (event.kind === "server.offline") {
		return {
			title: `Server offline: ${event.serverName}`,
			body: `${event.serverName} is no longer responding to health checks.`,
			href: `/dashboard/servers/${event.serverId}`,
		};
	}
	if (event.kind === "manual_recovery.required") {
		return {
			title: `Manual recovery required: ${event.serverName}`,
			body: `${event.impactedReplicas} active replica${event.impactedReplicas === 1 ? "" : "s"} require manual recovery.`,
			href: `/dashboard/servers/${event.serverId}`,
		};
	}
	const context = await serviceContext(event.serviceId);
	if (!context) return null;
	const serviceHref = `/dashboard/projects/${context.projectSlug}/${context.environmentName}/services/${event.serviceId}`;
	if (event.kind === "build.failed") {
		return {
			title: `Build failed: ${context.serviceName}`,
			body: event.error ?? `A build for ${context.serviceName} failed.`,
			href: `${serviceHref}/builds/${event.buildId}`,
		};
	}
	return {
		title: `Deployment failed: ${context.serviceName}`,
		body: event.failedStage
			? `Deployment failed during ${event.failedStage}.`
			: `A deployment for ${context.serviceName} failed.`,
		href: serviceHref,
	};
}

export async function deliverInAppNotification(event: NotificationEvent) {
	const rendered = await renderInAppNotification(event);
	if (!rendered) return;
	const recipients = await db
		.select({ id: user.id })
		.from(user)
		.where(sql`${user.banned} is not true`);
	if (!recipients.length) return;
	await db
		.insert(notifications)
		.values(
			recipients.map(({ id: userId }) => ({
				id: randomUUID(),
				eventId: event.occurrenceId,
				userId,
				kind: event.kind,
				...rendered,
			})),
		)
		.onConflictDoNothing({
			target: [notifications.eventId, notifications.userId],
		});
}
