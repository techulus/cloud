import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
	buildCutoverServiceRevisionSpec,
	type CutoverDeployedConfig,
} from "../lib/service-revision-cutover";
import {
	hashServiceRevisionSpec,
	SERVICE_REVISION_SCHEMA_VERSION,
} from "../lib/service-revision-spec";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
	throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString });

async function baseSchemaExists(client: PoolClient) {
	const result = await client.query<{ exists: boolean }>(
		`SELECT to_regclass('services') IS NOT NULL AS exists`,
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
					AND table_name = 'rollouts'
					AND column_name = 'service_revision_id'
			)
			OR NOT EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = current_schema()
					AND table_name = 'services'
					AND column_name = 'active_revision_id'
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
			revision_number integer NOT NULL,
			schema_version integer NOT NULL,
			specification jsonb NOT NULL,
			content_hash text NOT NULL,
			source_metadata jsonb,
			created_at timestamptz NOT NULL DEFAULT now()
		)
	`);
	await client.query(`
		ALTER TABLE services ADD COLUMN IF NOT EXISTS active_revision_id text;
		ALTER TABLE deployments ADD COLUMN IF NOT EXISTS service_revision_id text;
		ALTER TABLE rollouts ADD COLUMN IF NOT EXISTS service_revision_id text;
		ALTER TABLE deployment_ports ADD COLUMN IF NOT EXISTS container_port integer
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
		`SELECT * FROM services WHERE id = $1 FOR UPDATE`,
		[serviceId],
	);
	const service = serviceResult.rows[0];
	if (!service) throw new Error(`Service ${serviceId} not found`);
	let deployedConfig: CutoverDeployedConfig | null = null;
	if (service.deployed_config) {
		try {
			deployedConfig = JSON.parse(
				service.deployed_config,
			) as CutoverDeployedConfig;
		} catch {
			throw new Error(`Service ${serviceId} has invalid deployed_config JSON`);
		}
	}

	const [placementResult, portResult, secretResult, volumeResult] =
		await Promise.all([
			client.query(
				`SELECT server_id, count FROM service_replicas WHERE service_id = $1`,
				[serviceId],
			),
			client.query(
				`SELECT port, is_public, domain, protocol, external_port, tls_passthrough
				 FROM service_ports WHERE service_id = $1`,
				[serviceId],
			),
			client.query(
				`SELECT key, encrypted_value, updated_at FROM secrets WHERE service_id = $1`,
				[serviceId],
			),
			client.query(
				`SELECT name, container_path FROM service_volumes WHERE service_id = $1`,
				[serviceId],
			),
		]);

	const specification = buildCutoverServiceRevisionSpec({
		deployedConfig,
		liveDraft: {
			service: {
				id: service.id,
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
			placements: placementResult.rows.map((placement) => ({
				serverId: placement.server_id,
				count: placement.count,
			})),
			ports: portResult.rows.map((port) => ({
				port: port.port,
				isPublic: port.is_public,
				domain: port.domain,
				protocol: port.protocol,
				externalPort: port.external_port,
				tlsPassthrough: port.tls_passthrough,
			})),
			secrets: secretResult.rows.map((secret) => ({
				key: secret.key,
				encryptedValue: secret.encrypted_value,
				updatedAt: secret.updated_at,
			})),
			volumes: volumeResult.rows.map((volume) => ({
				name: volume.name,
				containerPath: volume.container_path,
			})),
		},
	});

	const totalReplicas = specification.placements.reduce(
		(total, placement) => total + placement.count,
		0,
	);
	const activeDeploymentResult = await client.query<{ active: boolean }>(
		`SELECT EXISTS (
			SELECT 1 FROM deployments
			WHERE service_id = $1
				AND runtime_desired_state <> 'removed'
				AND traffic_state <> 'inactive'
		) AS active`,
		[serviceId],
	);
	const hasActiveDeployment = activeDeploymentResult.rows[0]?.active ?? false;
	if (hasActiveDeployment && (totalReplicas < 1 || totalReplicas > 10)) {
		throw new Error(
			`Service ${serviceId} has invalid replica count ${totalReplicas}`,
		);
	}
	if (
		hasActiveDeployment &&
		specification.stateful &&
		(totalReplicas !== 1 || specification.placements.length !== 1)
	) {
		throw new Error(`Stateful service ${serviceId} has invalid placement`);
	}
	if (hasActiveDeployment) {
		const activeDeployments = await client.query<{ id: string }>(
			`SELECT id FROM deployments
			 WHERE service_id = $1
				AND runtime_desired_state <> 'removed'
				AND traffic_state <> 'inactive'`,
			[serviceId],
		);
		const expectedPorts = specification.ports
			.map((port) => port.containerPort)
			.sort((a, b) => a - b);
		for (const deployment of activeDeployments.rows) {
			const allocatedPorts = await client.query<{ container_port: number }>(
				`SELECT container_port FROM deployment_ports
				 WHERE deployment_id = $1 ORDER BY container_port`,
				[deployment.id],
			);
			if (
				JSON.stringify(
					allocatedPorts.rows.map((port) => port.container_port),
				) !== JSON.stringify(expectedPorts)
			) {
				throw new Error(
					`Deployment ${deployment.id} has incomplete runtime port allocation`,
				);
			}
		}
	}

	const contentHash = hashServiceRevisionSpec(specification);
	const existingRevision = await client.query(
		`SELECT id FROM service_revisions WHERE service_id = $1 AND content_hash = $2`,
		[serviceId, contentHash],
	);
	let revisionId = existingRevision.rows[0]?.id as string | undefined;
	if (!revisionId) {
		revisionId = randomUUID();
		await client.query(
			`INSERT INTO service_revisions (
				id, service_id, revision_number, schema_version, specification,
				content_hash, source_metadata
			) VALUES (
				$1, $2,
				(SELECT coalesce(max(revision_number), 0) + 1 FROM service_revisions WHERE service_id = $2),
				$3, $4, $5, $6
			)`,
			[
				revisionId,
				serviceId,
				SERVICE_REVISION_SCHEMA_VERSION,
				JSON.stringify(specification),
				contentHash,
				JSON.stringify({ sourceType: "cutover_bootstrap" }),
			],
		);
	}

	await client.query(
		`UPDATE deployments SET service_revision_id = $1
		 WHERE service_id = $2 AND service_revision_id IS NULL`,
		[revisionId, serviceId],
	);
	await client.query(
		`UPDATE rollouts SET service_revision_id = $1
		 WHERE service_id = $2 AND service_revision_id IS NULL`,
		[revisionId, serviceId],
	);
	await client.query(
		`UPDATE services SET active_revision_id = $1
		 WHERE id = $2 AND active_revision_id IS NULL
			AND EXISTS (
				SELECT 1 FROM deployments
				WHERE deployments.service_id = services.id
					AND deployments.runtime_desired_state <> 'removed'
					AND deployments.traffic_state <> 'inactive'
			)`,
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
			IF EXISTS (SELECT 1 FROM rollouts WHERE service_revision_id IS NULL) THEN
				RAISE EXCEPTION 'rollouts.service_revision_id backfill incomplete';
			END IF;
			IF EXISTS (SELECT 1 FROM deployment_ports WHERE container_port IS NULL) THEN
				RAISE EXCEPTION 'deployment_ports.container_port backfill incomplete';
			END IF;
		END $$
	`);
	const duplicateIps = await client.query<{
		server_id: string;
		ip_address: string;
		deployment_ids: string[];
	}>(`
		SELECT server_id, ip_address, array_agg(id ORDER BY id) AS deployment_ids
		FROM deployments
		WHERE ip_address IS NOT NULL
		GROUP BY server_id, ip_address
		HAVING count(*) > 1
		ORDER BY server_id, ip_address
		LIMIT 20
	`);
	if (duplicateIps.rows.length > 0) {
		const conflicts = duplicateIps.rows
			.map(
				(row) =>
					`server ${row.server_id} IP ${row.ip_address}: ${row.deployment_ids.join(", ")}`,
			)
			.join("; ");
		throw new Error(
			`Duplicate container IP allocations prevent cutover: ${conflicts}`,
		);
	}
	await client.query(`
		CREATE UNIQUE INDEX IF NOT EXISTS service_revisions_service_revision_number_idx
			ON service_revisions(service_id, revision_number);
		CREATE UNIQUE INDEX IF NOT EXISTS service_revisions_service_content_hash_idx
			ON service_revisions(service_id, content_hash);
		CREATE INDEX IF NOT EXISTS service_revisions_service_id_idx
			ON service_revisions(service_id);
		CREATE INDEX IF NOT EXISTS deployments_service_revision_id_idx
			ON deployments(service_revision_id);
		CREATE UNIQUE INDEX IF NOT EXISTS deployments_server_ip_address_idx
			ON deployments(server_id, ip_address);
		CREATE INDEX IF NOT EXISTS rollouts_service_revision_id_idx
			ON rollouts(service_revision_id)
	`);
	await client.query(`
		ALTER TABLE deployments ALTER COLUMN service_revision_id SET NOT NULL;
		ALTER TABLE rollouts ALTER COLUMN service_revision_id SET NOT NULL;
		ALTER TABLE deployment_ports ALTER COLUMN container_port SET NOT NULL
	`);
	await client.query(`
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_revisions_id_service_id_unique') THEN
				ALTER TABLE service_revisions ADD CONSTRAINT service_revisions_id_service_id_unique
					UNIQUE (id, service_id);
			END IF;
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'services_active_revision_id_service_revisions_id_fk') THEN
				ALTER TABLE services ADD CONSTRAINT services_active_revision_id_service_revisions_id_fk
					FOREIGN KEY (active_revision_id) REFERENCES service_revisions(id) ON DELETE SET NULL;
			END IF;
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployments_service_revision_service_fk') THEN
				ALTER TABLE deployments ADD CONSTRAINT deployments_service_revision_service_fk
					FOREIGN KEY (service_revision_id, service_id)
					REFERENCES service_revisions(id, service_id) ON DELETE NO ACTION;
			END IF;
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rollouts_service_revision_service_fk') THEN
				ALTER TABLE rollouts ADD CONSTRAINT rollouts_service_revision_service_fk
					FOREIGN KEY (service_revision_id, service_id)
					REFERENCES service_revisions(id, service_id) ON DELETE NO ACTION;
			END IF;
		END $$
	`);
	await client.query(
		`ALTER TABLE deployment_ports DROP COLUMN IF EXISTS service_port_id`,
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
			console.log(
				"Fresh database detected; schema push will create service revisions.",
			);
			return;
		}
		if (!(await cutoverIsRequired(client))) {
			await client.query("COMMIT");
			console.log("Service revision cutover already complete; skipping.");
			return;
		}
		const activeRollouts = await client.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM rollouts WHERE status IN ('queued', 'in_progress')`,
		);
		if (Number(activeRollouts.rows[0]?.count ?? 0) > 0) {
			throw new Error("Cutover requires zero queued or in-progress rollouts");
		}
		await prepareSchema(client);

		const serviceIds = await client.query<{ service_id: string }>(`
			SELECT DISTINCT service_id FROM deployments
			UNION
			SELECT DISTINCT service_id FROM rollouts
		`);
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
		console.log(
			`Service revision cutover complete for ${serviceIds.rowCount ?? 0} services.`,
		);
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
		await pool.end();
	}
}

await main();
