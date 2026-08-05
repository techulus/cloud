import { lt } from "drizzle-orm";
import { db } from "@/db";
import { serviceCommands } from "@/db/schema";
import { DAY_IN_MILLISECONDS, subtractMilliseconds } from "@/lib/date";

export const COMMAND_RETENTION_DAYS = 90;

export async function cleanupOldServiceCommands(now = new Date()) {
	const result = await db
		.delete(serviceCommands)
		.where(
			lt(
				serviceCommands.createdAt,
				subtractMilliseconds(now, COMMAND_RETENTION_DAYS * DAY_IN_MILLISECONDS),
			),
		);

	return result.rowCount ?? 0;
}
