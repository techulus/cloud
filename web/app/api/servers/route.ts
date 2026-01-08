export const dynamic = "force-dynamic";

import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { db } from "@/db";
import { servers } from "@/db/schema";

export async function GET() {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const data = await db
		.select({
			id: servers.id,
			name: servers.name,
			status: servers.status,
			wireguardIp: servers.wireguardIp,
			publicIp: servers.publicIp,
			isProxy: servers.isProxy,
		})
		.from(servers)
		.orderBy(servers.createdAt);

	return Response.json(data);
}
