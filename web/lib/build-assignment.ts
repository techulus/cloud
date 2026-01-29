import { db } from "@/db";
import { servers, services, serviceReplicas } from "@/db/schema";
import { eq, and, inArray, isNotNull, notInArray } from "drizzle-orm";
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

export async function selectBuildServerForPlatform(
	serviceId: string,
	platform: string,
): Promise<string> {
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

	const arch = platform.split("/")[1];

	const allowedBuildServerIds = await getSetting<string[]>(
		SETTING_KEYS.SERVERS_ALLOWED_FOR_BUILDS,
	);

	let onlineServers: { id: string; meta: { arch?: string } | null }[];

	if (allowedBuildServerIds && allowedBuildServerIds.length > 0) {
		onlineServers = await db
			.select({ id: servers.id, meta: servers.meta })
			.from(servers)
			.where(
				and(
					eq(servers.status, "online"),
					inArray(servers.id, allowedBuildServerIds),
				),
			);
	} else {
		onlineServers = await db
			.select({ id: servers.id, meta: servers.meta })
			.from(servers)
			.where(eq(servers.status, "online"));
	}

	const matchingServers = onlineServers.filter((s) => s.meta?.arch === arch);

	if (matchingServers.length === 0) {
		throw new Error(`No online servers available for platform ${platform}`);
	}

	return matchingServers[Math.floor(Math.random() * matchingServers.length)].id;
}

export async function getTargetPlatformsForService(
	serviceId: string,
): Promise<string[]> {
	const service = await db
		.select()
		.from(services)
		.where(eq(services.id, serviceId))
		.then((r) => r[0]);

	if (!service) {
		throw new Error("Service not found");
	}

	let targetPlatforms: string[] = [];

	if (service.autoPlace) {
		const excludedFromWorkload = await getSetting<string[]>(
			SETTING_KEYS.SERVERS_EXCLUDED_FROM_WORKLOAD_PLACEMENT,
		);

		const eligibleServers = await db
			.select({ meta: servers.meta })
			.from(servers)
			.where(
				excludedFromWorkload && excludedFromWorkload.length > 0
					? and(
							eq(servers.status, "online"),
							isNotNull(servers.wireguardIp),
							notInArray(servers.id, excludedFromWorkload),
						)
					: and(eq(servers.status, "online"), isNotNull(servers.wireguardIp)),
			);

		targetPlatforms = [
			...new Set(
				eligibleServers
					.map((s) => s.meta?.arch)
					.filter((arch): arch is string => !!arch)
					.map((arch) => `linux/${arch}`),
			),
		];
	} else {
		const replicas = await db
			.select({ meta: servers.meta })
			.from(serviceReplicas)
			.innerJoin(servers, eq(serviceReplicas.serverId, servers.id))
			.where(eq(serviceReplicas.serviceId, service.id));

		targetPlatforms = [
			...new Set(
				replicas
					.map((r) => r.meta?.arch)
					.filter((arch): arch is string => !!arch)
					.map((arch) => `linux/${arch}`),
			),
		];
	}

	if (targetPlatforms.length === 0) {
		targetPlatforms.push("linux/amd64", "linux/arm64");
	}

	return targetPlatforms;
}
