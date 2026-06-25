import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { getSetting } from "@/db/queries";
import { servers, serviceReplicas, services } from "@/db/schema";
import { SETTING_KEYS } from "@/lib/settings-keys";

type BuildTargetServer = {
	id: string;
	status: string;
	meta: { arch: string };
};

async function getStatefulBuildTargetServer(
	serviceId: string,
): Promise<BuildTargetServer> {
	const targetServers = await db
		.select({ id: servers.id, status: servers.status, meta: servers.meta })
		.from(serviceReplicas)
		.innerJoin(servers, eq(serviceReplicas.serverId, servers.id))
		.where(
			and(
				eq(serviceReplicas.serviceId, serviceId),
				gt(serviceReplicas.count, 0),
			),
		);

	if (targetServers.length !== 1) {
		throw new Error(
			"Stateful services must have exactly one active replica server",
		);
	}

	const [targetServer] = targetServers;

	if (targetServer.status !== "online") {
		throw new Error("Stateful service target server is offline");
	}

	if (!targetServer.meta?.arch) {
		throw new Error("Stateful service target server architecture is unknown");
	}

	return {
		...targetServer,
		meta: { arch: targetServer.meta.arch },
	};
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

	const arch = platform.split("/")[1];

	if (service.stateful) {
		const targetServer = await getStatefulBuildTargetServer(serviceId);
		if (targetServer.meta.arch !== arch) {
			throw new Error(
				`Stateful service target server architecture ${targetServer.meta.arch} does not match platform ${platform}`,
			);
		}

		return targetServer.id;
	}

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

	if (service.stateful) {
		const targetServer = await getStatefulBuildTargetServer(serviceId);
		return [`linux/${targetServer.meta.arch}`];
	}

	let targetPlatforms: string[] = [];

	const replicas = await db
		.select({ meta: servers.meta })
		.from(serviceReplicas)
		.innerJoin(servers, eq(serviceReplicas.serverId, servers.id))
		.where(
			and(
				eq(serviceReplicas.serviceId, service.id),
				gt(serviceReplicas.count, 0),
			),
		);

	targetPlatforms = [
		...new Set(
			replicas
				.map((r) => r.meta?.arch)
				.filter((arch): arch is string => !!arch)
				.map((arch) => `linux/${arch}`),
		),
	];

	if (targetPlatforms.length === 0) {
		targetPlatforms.push("linux/amd64", "linux/arm64");
	}

	return targetPlatforms;
}
