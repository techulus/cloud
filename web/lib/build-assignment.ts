import { db } from "@/db";
import { servers, services } from "@/db/schema";
import { eq, and } from "drizzle-orm";

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

	const onlineServers = await db
		.select({ id: servers.id })
		.from(servers)
		.where(eq(servers.status, "online"));

	if (onlineServers.length === 0) {
		throw new Error("No online servers available");
	}

	return onlineServers[Math.floor(Math.random() * onlineServers.length)].id;
}
