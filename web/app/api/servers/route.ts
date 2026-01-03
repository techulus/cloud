export const dynamic = "force-dynamic";

import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { and, eq, lt } from "drizzle-orm";

const HEARTBEAT_STALE_THRESHOLD_MS = 300 * 1000;

export async function GET() {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const staleThreshold = new Date(Date.now() - HEARTBEAT_STALE_THRESHOLD_MS);
	await db
		.update(servers)
		.set({ status: "offline" })
		.where(
			and(
				eq(servers.status, "online"),
				lt(servers.lastHeartbeat, staleThreshold),
			),
		);

	const data = await db
		.select({
			id: servers.id,
			name: servers.name,
			status: servers.status,
			wireguardIp: servers.wireguardIp,
			publicIp: servers.publicIp,
		})
		.from(servers)
		.orderBy(servers.createdAt);

	return Response.json(data);
}
