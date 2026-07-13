import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
	buildCutoverServiceRevisionSpec,
	type CutoverDeployedConfig,
} from "../lib/service-revision-cutover";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });

async function baseSchemaExists(client: PoolClient) {
	const result = await client.query<{ exists: boolean }>(
		"SELECT to_regclass('services') IS NOT NULL AS exists",
	);
	return result.rows[0]?.exists ?? false;
}

async function cutoverIsRequired(client: PoolClient) {
	const result = await client.query<{ required: boolean }>(`
		SELECT
			to_regclass('service_revisions') IS NULL
			OR NOT EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = current_schema()
					AND table_name = 'deployments'
					AND column_name = 'service_revision_id'
			)
			OR NOT EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = current_schema()
					AND table_name = 'deployment_ports'
					AND column_name = 'container_port'
			)
			OR EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = current_schema()
					AND table_name = 'deployment_ports'
					AND column_name = 'service_port_id'
			) AS required
	`);
	return result.rows[0]?.required ?? true;
}

async function prepareSchema(client: PoolClient) {
	await client.query(`
		CREATE TABLE IF NOT EXISTS service_revisions (
			id text PRIMARY KEY,
			service_id text NOT NULL CONSTRAINT service_revisions_service_id_services_id_fk
				REFERENCES services(id) ON DELETE CASCADE,
			specification jsonb NOT NULL,
			created_at timestamptz NOT NULL DEFAULT now(),
			CONSTRAINT service_revisions_id_service_id_unique UNIQUE (id, service_id)
		);
		ALTER TABLE deployments ADD COLUMN IF NOT EXISTS service_revision_id text;
		ALTER TABLE deployment_ports ADD COLUMN IF NOT EXISTS container_port integer;
	`);
	await client.query(`
		DO $$
		BEGIN
			IF EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = current_schema()
					AND table_name = 'deployment_ports'
					AND column_name = 'service_port_id'
			) THEN
				UPDATE deployment_ports AS deployment_port
				SET container_port = service_port.port
				FROM service_ports AS service_port
				WHERE deployment_port.service_port_id = service_port.id
					AND deployment_port.container_port IS NULL;
			END IF;
		END $$
	`);
}

async function captureBootstrapRevision(client: PoolClient, serviceId: string) {
	const serviceResult = await client.query(
		"SELECT * FROM services WHERE id = $1 FOR UPDATE",
		[serviceId],
	);
	const service = serviceResult.rows[0];
	if (!service) throw new Error("service not found");

	if (!service.deployed_config) {
		throw new Error("missing deployed_config");
	}
	let deployedConfig: CutoverDeployedConfig;
	try {
		deployedConfig = JSON.parse(service.deployed_config);
	} catch {
		throw new Error("invalid deployed_config JSON");
	}

	const [placements, ports, secrets, volumes] = await Promise.all([
		client.query(
			"SELECT server_id, count FROM service_replicas WHERE service_id = $1",
			[serviceId],
		),
		client.query(
			`SELECT port, is_public, domain, protocol, external_port, tls_passthrough
			 FROM service_ports WHERE service_id = $1`,
			[serviceId],
		),
		client.query(
			"SELECT key, encrypted_value, updated_at FROM secrets WHERE service_id = $1",
			[serviceId],
		),
		client.query(
			"SELECT name, container_path FROM service_volumes WHERE service_id = $1",
			[serviceId],
		),
	]);

	const specification = buildCutoverServiceRevisionSpec({
		deployedConfig,
		liveDraft: {
			service: {
				name: service.name,
				image: service.image,
				hostname: service.hostname,
				stateful: service.stateful,
				serverlessEnabled: service.serverless_enabled,
				serverlessSleepAfterSeconds: service.serverless_sleep_after_seconds,
				serverlessWakeTimeoutSeconds: service.serverless_wake_timeout_seconds,
				healthCheckCmd: service.health_check_cmd,
				healthCheckInterval: service.health_check_interval,
				healthCheckTimeout: service.health_check_timeout,
				healthCheckRetries: service.health_check_retries,
				healthCheckStartPeriod: service.health_check_start_period,
				startCommand: service.start_command,
				resourceCpuLimit: service.resource_cpu_limit,
				resourceMemoryLimitMb: service.resource_memory_limit_mb,
			},
			placements: placements.rows.map((row) => ({
				serverId: row.server_id,
				count: row.count,
			})),
			ports: ports.rows.map((row) => ({
				port: row.port,
				isPublic: row.is_public,
				domain: row.domain,
				protocol: row.protocol,
				externalPort: row.external_port,
				tlsPassthrough: row.tls_passthrough,
			})),
			secrets: secrets.rows.map((row) => ({
				key: row.key,
				encryptedValue: row.encrypted_value,
				updatedAt: row.updated_at,
			})),
			volumes: volumes.rows.map((row) => ({
				name: row.name,
				containerPath: row.container_path,
			})),
		},
	});
	const expectedContainerPorts = specification.ports
		.map((port) => port.containerPort)
		.sort((a, b) => a - b);
	const activeDeployments = await client.query<{
		id: string;
		container_ports: number[];
	}>(
		`SELECT deployment.id,
			COALESCE(
				array_agg(deployment_port.container_port ORDER BY deployment_port.container_port)
					FILTER (WHERE deployment_port.container_port IS NOT NULL),
				ARRAY[]::integer[]
			) AS container_ports
		 FROM deployments AS deployment
		 LEFT JOIN deployment_ports AS deployment_port
			ON deployment_port.deployment_id = deployment.id
		 WHERE deployment.service_id = $1
			AND deployment.runtime_desired_state <> 'removed'
			AND deployment.traffic_state = 'active'
		 GROUP BY deployment.id`,
		[serviceId],
	);
	for (const deployment of activeDeployments.rows) {
		if (
			JSON.stringify(deployment.container_ports) !==
			JSON.stringify(expectedContainerPorts)
		) {
			throw new Error(
				`active deployment ${deployment.id} ports differ from the deployed snapshot`,
			);
		}
	}

	const revisionId = randomUUID();
	await client.query(
		`INSERT INTO service_revisions (id, service_id, specification)
		 VALUES ($1, $2, $3)`,
		[revisionId, serviceId, JSON.stringify(specification)],
	);
	await client.query(
		`UPDATE deployments SET service_revision_id = $1
		 WHERE service_id = $2 AND service_revision_id IS NULL`,
		[revisionId, serviceId],
	);
}

async function finalizeSchema(client: PoolClient) {
	await client.query(`
		DO $$
		BEGIN
			IF EXISTS (SELECT 1 FROM deployments WHERE service_revision_id IS NULL) THEN
				RAISE EXCEPTION 'deployments.service_revision_id backfill incomplete';
			END IF;
			IF EXISTS (SELECT 1 FROM deployment_ports WHERE container_port IS NULL) THEN
				RAISE EXCEPTION 'deployment_ports.container_port backfill incomplete';
			END IF;
		END $$
	`);
	await client.query(`
		CREATE INDEX IF NOT EXISTS service_revisions_service_id_idx
			ON service_revisions(service_id);
		CREATE INDEX IF NOT EXISTS deployments_service_revision_id_idx
			ON deployments(service_revision_id);
		ALTER TABLE deployments ALTER COLUMN service_revision_id SET NOT NULL;
		ALTER TABLE deployment_ports ALTER COLUMN container_port SET NOT NULL;
	`);
	await client.query(`
		DO $$
		BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname = 'deployments_service_revision_service_fk'
			) THEN
				ALTER TABLE deployments
				ADD CONSTRAINT deployments_service_revision_service_fk
				FOREIGN KEY (service_revision_id, service_id)
				REFERENCES service_revisions(id, service_id) ON DELETE NO ACTION;
			END IF;
		END $$
	`);
	await client.query(
		"ALTER TABLE deployment_ports DROP COLUMN IF EXISTS service_port_id",
	);
}

async function main() {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtext('service-revisions-cutover'))",
		);
		if (!(await baseSchemaExists(client))) {
			await client.query("COMMIT");
			return;
		}
		if (!(await cutoverIsRequired(client))) {
			await client.query("COMMIT");
			return;
		}

		const activeRollouts = await client.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM rollouts WHERE status IN ('queued', 'in_progress')",
		);
		if (Number(activeRollouts.rows[0]?.count ?? 0) > 0) {
			throw new Error("cutover requires zero queued or in-progress rollouts");
		}

		await client.query(
			"DELETE FROM deployments WHERE traffic_state <> 'active' OR runtime_desired_state = 'removed'",
		);
		await prepareSchema(client);
		const serviceIds = await client.query<{ service_id: string }>(
			"SELECT DISTINCT service_id FROM deployments",
		);
		for (const { service_id: serviceId } of serviceIds.rows) {
			try {
				await captureBootstrapRevision(client, serviceId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Service ${serviceId}: ${message}`);
			}
		}
		await finalizeSchema(client);
		await client.query("COMMIT");
		console.log(`Backfilled ${serviceIds.rowCount ?? 0} service revisions.`);
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
		await pool.end();
	}
}

await main();
