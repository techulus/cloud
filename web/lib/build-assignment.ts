import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { getSetting } from "@/db/queries";
import { servers } from "@/db/schema";
import type { ServiceRevisionSpec } from "@/lib/service-revision-spec";
import { SETTING_KEYS } from "@/lib/settings-keys";

type BuildTargetServer = {
	id: string;
	status: string;
	meta: { arch: string };
};

async function getStatefulBuildTargetServer(
	specification: ServiceRevisionSpec,
): Promise<BuildTargetServer> {
	const placements = specification.placements.filter(
		(placement) => placement.count > 0,
	);
	if (placements.length !== 1 || placements[0].count !== 1) {
		throw new Error(
			"Stateful service revisions must have exactly one active replica server",
		);
	}

	const targetServer = await db
		.select({ id: servers.id, status: servers.status, meta: servers.meta })
		.from(servers)
		.where(eq(servers.id, placements[0].serverId))
		.then((rows) => rows[0]);
	if (!targetServer) {
		throw new Error("Stateful service revision target server was not found");
	}
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

export async function selectBuildServerForRevision(
	specification: ServiceRevisionSpec,
	platform: string,
): Promise<string> {
	const arch = platform.split("/")[1];
	if (!arch) throw new Error(`Invalid build platform ${platform}`);

	if (specification.stateful) {
		const targetServer = await getStatefulBuildTargetServer(specification);
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
	const onlineServers = allowedBuildServerIds?.length
		? await db
				.select({ id: servers.id, meta: servers.meta })
				.from(servers)
				.where(
					and(
						eq(servers.status, "online"),
						inArray(servers.id, allowedBuildServerIds),
					),
				)
		: await db
				.select({ id: servers.id, meta: servers.meta })
				.from(servers)
				.where(eq(servers.status, "online"));
	const matchingServers = onlineServers.filter(
		(server) => server.meta?.arch === arch,
	);
	if (matchingServers.length === 0) {
		throw new Error(`No online servers available for platform ${platform}`);
	}
	return matchingServers[Math.floor(Math.random() * matchingServers.length)].id;
}

export async function getTargetPlatformsForRevision(
	specification: ServiceRevisionSpec,
): Promise<string[]> {
	if (specification.stateful) {
		const targetServer = await getStatefulBuildTargetServer(specification);
		return [`linux/${targetServer.meta.arch}`];
	}

	const serverIds = specification.placements
		.filter((placement) => placement.count > 0)
		.map((placement) => placement.serverId);
	if (serverIds.length === 0) return ["linux/amd64", "linux/arm64"];

	const placementServers = await db
		.select({ id: servers.id, meta: servers.meta })
		.from(servers)
		.where(inArray(servers.id, serverIds));
	if (placementServers.length !== new Set(serverIds).size) {
		throw new Error("A service revision placement server was not found");
	}
	const targetPlatforms = [
		...new Set(
			placementServers
				.map((server) => server.meta?.arch)
				.filter((arch): arch is string => !!arch)
				.map((arch) => `linux/${arch}`),
		),
	];
	if (targetPlatforms.length === 0) {
		throw new Error("Service revision placement architectures are unknown");
	}
	return targetPlatforms;
}
