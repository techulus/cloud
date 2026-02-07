# Production Deployment

Docker Compose setup with Traefik for SSL termination via Let's Encrypt.

## Quick Start

```bash
cp .env.example .env
# Edit .env with your values

docker compose -f compose.production.yml up -d --pull always
```

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

## Database Migrations

Schema is synced automatically on container startup via `drizzle-kit push`. This approach auto-confirms non-destructive changes (adding tables, columns, indexes) but will **not** auto-apply destructive changes like dropping columns or tables — those require manual intervention.

**Future plan:** Once the schema stabilizes, switch to `drizzle-kit generate` + `drizzle-orm migrate()` with pre-generated SQL migration files. This will eliminate the esbuild/drizzle-kit dependency from the production image.

## Commands

```bash
docker compose -f compose.production.yml ps
docker compose -f compose.production.yml logs -f
docker compose -f compose.production.yml down
```
