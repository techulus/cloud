export const dynamic = "force-dynamic";

import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { db } from "@/db";
import { servers } from "@/db/schema";
import { notInArray } from "drizzle-orm";
import { getSetting } from "@/db/queries";
import { SETTING_KEYS } from "@/lib/settings-keys";

export async function GET(request: Request) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const forPlacement = url.searchParams.get("forPlacement") === "true";

	let excludedIds: string[] = [];
	if (forPlacement) {
		excludedIds =
			(await getSetting<string[]>(
				SETTING_KEYS.SERVERS_EXCLUDED_FROM_WORKLOAD_PLACEMENT,
			)) || [];
	}

	const query = db
		.select({
			id: servers.id,
			name: servers.name,
			status: servers.status,
			wireguardIp: servers.wireguardIp,
			publicIp: servers.publicIp,
			isProxy: servers.isProxy,
			resourcesCpu: servers.resourcesCpu,
			resourcesMemory: servers.resourcesMemory,
			resourcesDisk: servers.resourcesDisk,
			meta: servers.meta,
		})
		.from(servers);

	const data =
		excludedIds.length > 0
			? await query
					.where(notInArray(servers.id, excludedIds))
					.orderBy(servers.createdAt)
			: await query.orderBy(servers.createdAt);

	return Response.json(data);
}
