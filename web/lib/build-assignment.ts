import { db } from "@/db";
import { servers, services } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getSetting } from "@/db/queries";
import { SETTING_KEYS } from "@/lib/settings-keys";

export async function selectBuildServer(serviceId: string): Promise<string> {
	const service = await db
		.select()
		.from(services)
		.where(eq(services.id, serviceId))
		.then((r) => r[0]);

	if (!service) {
		throw new Error("Service not found");
	}

	if (service.stateful && service.lockedServerId) {
		const server = await db
			.select()
			.from(servers)
			.where(
				and(
					eq(servers.id, service.lockedServerId),
					eq(servers.status, "online"),
				),
			)
			.then((r) => r[0]);

		if (!server) {
			throw new Error("Locked server is offline");
		}

		return server.id;
	}

	const allowedBuildServerIds = await getSetting<string[]>(
		SETTING_KEYS.SERVERS_ALLOWED_FOR_BUILDS,
	);

	let onlineServers: { id: string }[];

	if (allowedBuildServerIds && allowedBuildServerIds.length > 0) {
		onlineServers = await db
			.select({ id: servers.id })
			.from(servers)
			.where(
				and(
					eq(servers.status, "online"),
					inArray(servers.id, allowedBuildServerIds),
				),
			);
	} else {
		onlineServers = await db
			.select({ id: servers.id })
			.from(servers)
			.where(eq(servers.status, "online"));
	}

	if (onlineServers.length === 0) {
		throw new Error("No online servers available for builds");
	}

	return onlineServers[Math.floor(Math.random() * onlineServers.length)].id;
}
