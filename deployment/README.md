# Production Deployment

Docker Compose setup with Traefik for SSL termination via Let's Encrypt.

## Quick Start

```bash
cp .env.example .env
# Edit .env with your values

docker compose -f compose.production.yml up -d --pull always --remove-orphans
```

After the one-shot `migrate` service completes, create the first admin user:

```bash
docker compose -f compose.production.yml run --rm web node scripts/admin.mjs --create admin@example.com
```

The command runs inside the Docker image, writes the admin user to the
configured database, and prints a random password once. Store the password,
sign in as that admin, then invite developers and readers from Settings.
Authenticated role-gated access is blocked until one admin user exists.

To reset the existing admin password, run:

```bash
docker compose -f compose.production.yml run --rm web node scripts/admin.mjs --reset-password admin@example.com
```

The reset command refuses to run unless the provided email is the only admin
user.

For production hosts, cap Docker logs in `/etc/docker/daemon.json` or use the
installer, which writes bounded `json-file` log settings on fresh Docker hosts.
Prefer versioned or digest-pinned image references over mutable tags when you
operate a long-lived deployment.

Health checks in these Compose files are for visibility. Plain Compose reports
unhealthy containers but does not restart them automatically.

## Services

| Service | Endpoint |
|---------|----------|
| Web | `https://${ROOT_DOMAIN}` |
| Registry | `https://registry.${ROOT_DOMAIN}` |
| Logs | `https://logs.${ROOT_DOMAIN}` |
| PostgreSQL | Internal only |
| Inngest | Internal only |

## Environment Setup

Generate registry auth:
```bash
htpasswd -nB admin
# Escape $ as $$ in .env
```

Generate Inngest keys:
```bash
# Signing key (for request verification)
openssl rand -hex 32
# Prefix with: signkey-prod-

# Event key (for sending events)
openssl rand -hex 16
```

Add to `.env`:
```
INNGEST_SIGNING_KEY=signkey-prod-<your-signing-key>
INNGEST_EVENT_KEY=<your-event-key>
```

### Web Replicas

Set `WEB_REPLICAS` in `.env` to run multiple control plane web containers:

```env
WEB_REPLICAS=2
```

Traefik discovers the replicated `web` containers through the Docker provider
and load balances requests for `${ROOT_DOMAIN}` across them. Schema sync runs
once from the dedicated `migrate` service before the replicated `web` containers
start, so scaling `WEB_REPLICAS` does not run migrations from every replica.

## Database Migrations

Schema is synced automatically by the one-shot `migrate` service via `drizzle-kit push --force`. This keeps deployment non-interactive, including schema changes Drizzle classifies as data-loss operations such as dropping columns. If schema sync fails, `web` startup is blocked; inspect the failure with `docker compose -f compose.production.yml logs migrate`.

### Immutable service revision cutover

The service-revision release is a maintenance-window cutover. Do not start the
new agents across the fleet at the same time.

1. Pause builds, schedules, migrations, restores, and rollout workers. Verify
   that no rollout is `queued` or `in_progress`. Verify every service has no
   pending secret additions, edits, or removals; deploy or revert those changes
   before the maintenance window.
2. Set `EXPECTED_STATE_MAINTENANCE_MODE=true`. Stop every old agent so each
   server keeps running its last applied container and cluster state.
3. Stop the old `web` and `inngest` services. Take and verify a PostgreSQL
   backup.
4. Run the new `migrate` image. It executes
   `scripts/cutover-service-revisions.ts` before `drizzle-kit push`. The script
   aborts and rolls back if active rollouts exist or any runtime row cannot be
   attached to a baseline revision.
5. Start the new control plane while maintenance mode remains enabled. Install
   the new agent binary on every server, but leave the agents stopped.
6. Set `EXPECTED_STATE_MAINTENANCE_MODE=false` and restart the control plane.
   Confirm server health identifies every stopped or old node as requiring the
   `service_revision_v1` capability.
7. Start one server agent. Its synchronous startup report must register the
   capability before it requests expected state.
8. Let that server recreate its pre-cutover containers one at a time. Verify
   container health, volume mounts, DNS, HTTP and L4 routes, certificates,
   WireGuard, and serverless behavior before starting the next server.
9. Continue through the fleet. Handle stateful and single-replica services in
   an explicit maintenance order, then resume workflow producers.

Each recreation pulls and verifies the image before removing the old container.
A failed pull leaves the old container running and backs off only that action;
other container and cluster reconciliation continues.

The agent waits for each recreated container before starting the next legacy
recreation. Services with a health check must become healthy; services without
one must remain running through a 30-second stabilization period.

Pull-before-remove minimizes downtime but cannot eliminate it. The replacement
uses the same static IP, so every container has a stop-to-start gap. Existing
connections to that replica may reset. Multi-replica services remain available
only through healthy replicas on other containers. Single-replica and stateful
services have bounded customer-visible downtime. Verify a healthy remaining
replica before allowing the next replica recreation.

Keep `services.deployed_config` unchanged for the burn-in release. The
application does not read or write it; it remains only as recovery evidence.

**Future plan:** Once the schema stabilizes, switch to `drizzle-kit generate` + `drizzle-orm migrate()` with pre-generated SQL migration files. This will eliminate the esbuild/drizzle-kit dependency from the production image.

## Commands

```bash
docker compose -f compose.production.yml ps
docker compose -f compose.production.yml logs -f
docker compose -f compose.production.yml logs migrate
docker compose -f compose.production.yml run --rm web node scripts/admin.mjs --create admin@example.com
docker compose -f compose.production.yml run --rm web node scripts/admin.mjs --reset-password admin@example.com
docker compose -f compose.production.yml down --remove-orphans
```
