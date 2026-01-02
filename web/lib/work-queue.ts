import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { workQueue } from "@/db/schema";
import type { WorkQueue } from "@/db/types";

export async function enqueueWork(
	serverId: string,
	type: WorkQueue["type"],
	payload: Record<string, unknown>,
) {
	await db.insert(workQueue).values({
		id: randomUUID(),
		serverId,
		type,
		payload: JSON.stringify(payload),
	});
}
