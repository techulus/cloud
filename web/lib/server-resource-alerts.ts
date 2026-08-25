import { eq } from "drizzle-orm";
import { db } from "@/db";
import { type ServerResourceAlerts, servers } from "@/db/schema";
import type { NotificationEvent } from "@/lib/inngest/events/notification";
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
	const onlineServerIds = serverRows
		.filter((server) => server.status === "online")
		.map((server) => server.id);
	const usageByServer = await queryNodeResourceUsageAverages(onlineServerIds);
	const detectedAt = now.toISOString();
	const notifications: NotificationEvent[] = [];
	const updates: Array<{
		id: string;
		resourceAlerts: ServerResourceAlerts | null;
	}> = [];

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
		if (!usage) continue;

		const next = { ...previous };
		let changed = false;
		for (const resource of Object.keys(RESOURCES) as Resource[]) {
			const { metric, threshold } = RESOURCES[resource];
			const usagePercent = usage[metric];
			if (usagePercent === null) continue;

			const active = next[resource];
			if (active) {
				if (usagePercent <= threshold - RECOVERY_MARGIN_PERCENT) {
					delete next[resource];
					changed = true;
				}
				continue;
			}

			if (usagePercent < threshold) continue;
			next[resource] = {
				usagePercent,
				thresholdPercent: threshold,
				detectedAt,
			};
			changed = true;
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
	}

	if (updates.length > 0) {
		await db.transaction(async (tx) => {
			for (const update of updates) {
				await tx
					.update(servers)
					.set({ resourceAlerts: update.resourceAlerts })
					.where(eq(servers.id, update.id));
			}
		});
	}

	return notifications;
}
