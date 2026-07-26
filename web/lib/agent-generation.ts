import { sql } from "drizzle-orm";
import type { db } from "@/db";

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function bumpAgentGeneration(
	tx: DbTransaction,
	serverId: string,
): Promise<number> {
	const result = await tx.execute(sql`
		UPDATE servers
		SET agent_generation = agent_generation + 1
		WHERE id = ${serverId}
		RETURNING agent_generation
	`);
	const generation = Number(result.rows[0]?.agent_generation);
	if (!Number.isSafeInteger(generation)) {
		throw new Error(`Server ${serverId} not found while bumping generation`);
	}
	await tx.execute(
		sql`SELECT pg_notify('agent_generation', ${serverId} || ':' || ${generation}::text)`,
	);
	return generation;
}
