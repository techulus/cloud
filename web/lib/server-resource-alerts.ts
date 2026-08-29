import { eq } from "drizzle-orm";
import { db } from "@/db";
import { type ServerResourceAlerts, servers } from "@/db/schema";
import type { NotificationEvent } from "@/lib/inngest/events/notification";
import { notify } from "@/lib/notifications";
import {
	type NodeResourceUsageAverages,
	queryNodeResourceUsageAverages,
} from "@/lib/victoria-metrics";

type Resource = "cpu" | "memory" | "disk";

const RESOURCES: Record<
	Resource,
	{ metric: keyof NodeResourceUsageAverages; threshold: number }
> = {
	cpu: { metric: "cpuUsagePercent", threshold: 90 },
	memory: { metric: "memoryUsagePercent", threshold: 90 },
	disk: { metric: "diskUsagePercent", threshold: 85 },
};

const RECOVERY_MARGIN_PERCENT = 5;

type ResourceAlertUpdate = {
	id: string;
	resourceAlerts: ServerResourceAlerts | null;
};

async function persistResourceAlerts(updates: ResourceAlertUpdate[]) {
	if (updates.length === 0) return;
	await db.transaction((tx) =>
		Promise.all(
			updates.map((update) =>
				tx
					.update(servers)
					.set({ resourceAlerts: update.resourceAlerts })
					.where(eq(servers.id, update.id)),
			),
		),
	);
}

export async function evaluateServerResourceAlerts(
	now = new Date(),
): Promise<NotificationEvent[]> {
	const serverRows = await db
		.select({
			id: servers.id,
			name: servers.name,
			status: servers.status,
			resourceAlerts: servers.resourceAlerts,
		})
		.from(servers);
	const onlineServerIds: string[] = [];
	for (const server of serverRows) {
		if (server.status === "online") onlineServerIds.push(server.id);
	}
	const usageByServer = await queryNodeResourceUsageAverages(onlineServerIds);
	const detectedAt = now.toISOString();
	const notifications: NotificationEvent[] = [];
	const updates: ResourceAlertUpdate[] = [];
	const enqueuedUpdates: ResourceAlertUpdate[] = [];

	// ponytail: move evaluation and routing to vmalert + Alertmanager if alert
	// types expand enough to justify two more services.
	for (const server of serverRows) {
		const previous = server.resourceAlerts ?? {};
		if (server.status !== "online") {
			if (Object.keys(previous).length > 0) {
				updates.push({ id: server.id, resourceAlerts: null });
			}
			continue;
		}

		const usage = usageByServer.get(server.id);
		const next = { ...previous };
		const pendingResources: Resource[] = [];
		let changed = false;
		for (const resource of Object.keys(RESOURCES) as Resource[]) {
			const { metric, threshold } = RESOURCES[resource];
			const usagePercent = usage?.[metric] ?? null;
			const active = next[resource];
			if (active) {
				if (
					usagePercent !== null &&
					usagePercent <= threshold - RECOVERY_MARGIN_PERCENT
				) {
					delete next[resource];
					changed = true;
					continue;
				}
				if (!active.notificationEnqueued) {
					pendingResources.push(resource);
					notifications.push({
						kind: "server.resource_usage",
						occurrenceId: `server-resource-usage-${server.id}-${resource}-${new Date(active.detectedAt).getTime()}`,
						serverId: server.id,
						serverName: server.name,
						resource,
						usagePercent: active.usagePercent,
						thresholdPercent: active.thresholdPercent,
						detectedAt: active.detectedAt,
					});
				}
				continue;
			}

			if (usagePercent === null) continue;
			if (usagePercent < threshold) continue;
			next[resource] = {
				usagePercent,
				thresholdPercent: threshold,
				detectedAt,
				notificationEnqueued: false,
			};
			changed = true;
			pendingResources.push(resource);
			notifications.push({
				kind: "server.resource_usage",
				occurrenceId: `server-resource-usage-${server.id}-${resource}-${now.getTime()}`,
				serverId: server.id,
				serverName: server.name,
				resource,
				usagePercent,
				thresholdPercent: threshold,
				detectedAt,
			});
		}

		if (changed) {
			updates.push({
				id: server.id,
				resourceAlerts: Object.keys(next).length > 0 ? next : null,
			});
		}
		if (pendingResources.length > 0) {
			const enqueued = { ...next };
			for (const resource of pendingResources) {
				enqueued[resource] = {
					...enqueued[resource]!,
					notificationEnqueued: true,
				};
			}
			enqueuedUpdates.push({ id: server.id, resourceAlerts: enqueued });
		}
	}

	await persistResourceAlerts(updates);
	if (notifications.length > 0) {
		await Promise.all(notifications.map((event) => notify(event)));
		await persistResourceAlerts(enqueuedUpdates);
	}

	return notifications;
}
