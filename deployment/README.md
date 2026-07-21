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

Schema is synced automatically by the one-shot `migrate` service via `drizzle-kit push`. Non-destructive changes are applied automatically. Changes Drizzle classifies as data-loss operations fail closed and require manual intervention. If schema sync fails, `web` startup is blocked; inspect the failure with `docker compose -f compose.production.yml logs migrate`.

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
