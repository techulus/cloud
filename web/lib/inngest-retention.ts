import { Client } from "pg";

export const INNGEST_RETENTION_DAYS = 30;

// Predicates follow Inngest's self-hosting retention guide (docs/POSTGRES_RETENTION.md).
// Only runs that reached a terminal status are deleted; children before anchors.
const TERMINAL_STATUSES = "50, 300, 400, 500, 600";
const expiredTraceRuns = `SELECT run_id FROM trace_runs WHERE status IN (${TERMINAL_STATUSES}) AND ended_at < (extract(epoch FROM now()) * 1000 - $1::bigint * 86400000)::bigint`;
const expiredFinishes = `SELECT run_id FROM function_finishes WHERE created_at < (now() AT TIME ZONE 'UTC') - make_interval(days => $1::int)`;

const PRUNE_STATEMENTS: [table: string, sql: string][] = [
	["spans", `DELETE FROM spans WHERE run_id IN (${expiredTraceRuns})`],
	["traces", `DELETE FROM traces WHERE run_id IN (${expiredTraceRuns})`],
	[
		"event_batches",
		`DELETE FROM event_batches WHERE run_id IN (${expiredTraceRuns})`,
	],
	[
		"trace_runs",
		`DELETE FROM trace_runs WHERE status IN (${TERMINAL_STATUSES}) AND ended_at < (extract(epoch FROM now()) * 1000 - $1::bigint * 86400000)::bigint`,
	],
	["history", `DELETE FROM history WHERE run_id IN (${expiredFinishes})`],
	[
		"function_runs",
		`DELETE FROM function_runs WHERE run_id IN (${expiredFinishes})`,
	],
	[
		"function_finishes",
		`DELETE FROM function_finishes WHERE created_at < (now() AT TIME ZONE 'UTC') - make_interval(days => $1::int)`,
	],
	[
		"events",
		`DELETE FROM events e WHERE e.received_at < (now() AT TIME ZONE 'UTC') - make_interval(days => $1::int) AND NOT EXISTS (SELECT 1 FROM function_runs fr LEFT JOIN function_finishes ff ON ff.run_id = fr.run_id WHERE fr.event_id = e.internal_id AND ff.run_id IS NULL)`,
	],
];

export async function pruneInngestHistory() {
	const connectionString = process.env.INNGEST_DATABASE_URL;
	if (!connectionString) return { skipped: true as const };

	const client = new Client({ connectionString });
	client.on("error", (error) => {
		console.error("[inngest-retention] connection error", error);
	});
	await client.connect();
	try {
		// One transaction so now() — and therefore the cutoff — is identical for every statement.
		await client.query("BEGIN");
		const deleted: Record<string, number> = {};
		for (const [table, sql] of PRUNE_STATEMENTS) {
			const result = await client.query(sql, [INNGEST_RETENTION_DAYS]);
			deleted[table] = result.rowCount ?? 0;
		}
		await client.query("COMMIT");
		return { skipped: false as const, deleted };
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		await client.end();
	}
}
