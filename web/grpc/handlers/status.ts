import { db } from "@/db";
import {
	servers,
	workQueue,
	deployments,
	serverContainers,
	proxyRoutes,
	servicePorts,
} from "@/db/schema";
import { eq, and, ne, notInArray } from "drizzle-orm";
import { getWireGuardPeers, isProxyServer } from "@/lib/wireguard";
import { PROXY_WIREGUARD_IP } from "@/lib/constants";
import { randomUUID } from "node:crypto";

interface StatusUpdate {
	resources?: {
		cpuCores?: number;
		memoryTotalMb?: number;
		diskTotalGb?: number;
	};
	publicIp?: string;
	containers?: Array<{
		id: string;
		name: string;
		image: string;
		state: string;
		created: number;
	}>;
	proxyRoutes?: Array<{
		routeId: string;
		domain: string;
		upstreams: string[];
	}>;
}

export async function handleStatusUpdate(
	serverId: string,
	status: StatusUpdate,
): Promise<void> {
	const serverResults = await db
		.select()
		.from(servers)
		.where(eq(servers.id, serverId));

	const server = serverResults[0];
	if (!server) {
		throw new Error("Server not found");
	}

	const updateData: Record<string, unknown> = {
		lastHeartbeat: new Date(),
		status: "online",
	};

	if (status.resources) {
		if (status.resources.cpuCores !== undefined) {
			updateData.resourcesCpu = status.resources.cpuCores;
		}
		if (status.resources.memoryTotalMb !== undefined) {
			updateData.resourcesMemory = status.resources.memoryTotalMb;
		}
		if (status.resources.diskTotalGb !== undefined) {
			updateData.resourcesDisk = status.resources.diskTotalGb;
		}
	}

	const publicIpChanged =
		status.publicIp && status.publicIp !== server.publicIp;
	if (status.publicIp) {
		updateData.publicIp = status.publicIp;
	}

	await db.update(servers).set(updateData).where(eq(servers.id, serverId));

	if (publicIpChanged && server.wireguardIp) {
		await handlePublicIpChange(serverId, server.wireguardIp);
	}

	if (status.containers) {
		await syncContainers(serverId, status.containers);
	}

	if (status.proxyRoutes) {
		await syncProxyRoutes(serverId, status.proxyRoutes);
	}
}

async function handlePublicIpChange(
	serverId: string,
	wireguardIp: string,
): Promise<void> {
	if (isProxyServer(wireguardIp)) {
		const workers = await db
			.select({ id: servers.id, wireguardIp: servers.wireguardIp })
			.from(servers)
			.where(
				and(
					ne(servers.id, serverId),
					eq(servers.status, "online"),
					ne(servers.wireguardIp, PROXY_WIREGUARD_IP),
				),
			);

		for (const worker of workers) {
			const peers = await getWireGuardPeers(worker.id, worker.wireguardIp!);
			await db.insert(workQueue).values({
				id: randomUUID(),
				serverId: worker.id,
				type: "update_wireguard",
				payload: JSON.stringify({ peers }),
			});
		}
	} else {
		const proxyServer = await db
			.select({ id: servers.id, wireguardIp: servers.wireguardIp })
			.from(servers)
			.where(
				and(
					eq(servers.status, "online"),
					eq(servers.wireguardIp, PROXY_WIREGUARD_IP),
				),
			)
			.then((r) => r[0]);

		if (proxyServer) {
			const peers = await getWireGuardPeers(
				proxyServer.id,
				proxyServer.wireguardIp!,
			);
			await db.insert(workQueue).values({
				id: randomUUID(),
				serverId: proxyServer.id,
				type: "update_wireguard",
				payload: JSON.stringify({ peers }),
			});
		}
	}
}

async function syncContainers(
	serverId: string,
	containers: Array<{
		id: string;
		name: string;
		image: string;
		state: string;
		created: number;
	}>,
): Promise<void> {
	if (containers.length === 0) {
		await db
			.delete(serverContainers)
			.where(eq(serverContainers.serverId, serverId));
		return;
	}

	const allDeployments = await db
		.select({ containerId: deployments.containerId })
		.from(deployments)
		.where(eq(deployments.serverId, serverId));

	const managedContainerIds = new Set(
		allDeployments.map((d) => d.containerId).filter(Boolean),
	);

	const seenContainerIds: string[] = [];

	for (const container of containers) {
		seenContainerIds.push(container.id);
		const isManaged = managedContainerIds.has(container.id);

		const existing = await db
			.select()
			.from(serverContainers)
			.where(
				and(
					eq(serverContainers.serverId, serverId),
					eq(serverContainers.containerId, container.id),
				),
			);

		if (existing.length > 0) {
			await db
				.update(serverContainers)
				.set({
					name: container.name,
					image: container.image,
					state: container.state,
					isManaged,
					lastSeen: new Date(),
				})
				.where(eq(serverContainers.id, existing[0].id));
		} else {
			await db.insert(serverContainers).values({
				id: randomUUID(),
				serverId,
				containerId: container.id,
				name: container.name,
				image: container.image,
				state: container.state,
				isManaged,
			});
		}
	}

	if (seenContainerIds.length > 0) {
		await db
			.delete(serverContainers)
			.where(
				and(
					eq(serverContainers.serverId, serverId),
					notInArray(serverContainers.containerId, seenContainerIds),
				),
			);
	}
}

async function syncProxyRoutes(
	serverId: string,
	routes: Array<{
		routeId: string;
		domain: string;
		upstreams: string[];
	}>,
): Promise<void> {
	if (routes.length === 0) {
		await db.delete(proxyRoutes).where(eq(proxyRoutes.serverId, serverId));
		return;
	}

	const allServicePorts = await db
		.select({ subdomain: servicePorts.subdomain })
		.from(servicePorts)
		.where(eq(servicePorts.isPublic, true));

	const managedDomains = new Set(
		allServicePorts.map((sp) => sp.subdomain).filter(Boolean),
	);

	const seenRouteIds: string[] = [];

	for (const route of routes) {
		seenRouteIds.push(route.routeId);
		const isManaged = managedDomains.has(route.domain.split(".")[0]);

		const existing = await db
			.select()
			.from(proxyRoutes)
			.where(
				and(
					eq(proxyRoutes.serverId, serverId),
					eq(proxyRoutes.routeId, route.routeId),
				),
			);

		if (existing.length > 0) {
			await db
				.update(proxyRoutes)
				.set({
					domain: route.domain,
					upstreams: JSON.stringify(route.upstreams),
					isManaged,
					lastSeen: new Date(),
				})
				.where(eq(proxyRoutes.id, existing[0].id));
		} else {
			await db.insert(proxyRoutes).values({
				id: randomUUID(),
				serverId,
				routeId: route.routeId,
				domain: route.domain,
				upstreams: JSON.stringify(route.upstreams),
				isManaged,
			});
		}
	}

	if (seenRouteIds.length > 0) {
		await db
			.delete(proxyRoutes)
			.where(
				and(
					eq(proxyRoutes.serverId, serverId),
					notInArray(proxyRoutes.routeId, seenRouteIds),
				),
			);
	}
}
