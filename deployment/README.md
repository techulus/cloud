# Production Deployment

Docker Compose setup with Traefik for SSL termination via Let's Encrypt.

A user-owned Google Artifact Registry Docker repository is mandatory. Complete
the [GAR setup](../docs/infrastructure/registry.mdx), including its
repository-scoped Writer account and cleanup policy, before starting Compose.
Create the resources in Google Cloud Console, then encode the downloaded JSON
key on a trusted workstation using the commands in the guide.

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

| Service    | Endpoint                      |
| ---------- | ----------------------------- |
| Web        | `https://${ROOT_DOMAIN}`      |
| Logs       | `https://logs.${ROOT_DOMAIN}` |
| PostgreSQL | Internal only                 |
| Inngest    | Internal only                 |

## Environment Setup

Set `GAR_REPOSITORY` and `GAR_AGENT_KEY_BASE64` in `.env`. The installer reads
the Writer key without terminal echo. Follow the registry guide to encode the
complete JSON key as one portable base64 line and keep credential files mode
`600`. Base64 is not encryption.

The GAR policy keeps the 10 most recent versions per package without a prefix
filter and deletes versions in any tag state after 30 days. This can delete an
active or rollback image. Failed builds count, and multi-platform images mean
10 versions is not 10 builds or rollouts. Deleted services retain their newest
versions. A seven-day data restore does not guarantee its image remains.

Existing operators must deploy the Writer-only code before replacing the old
protected-tag Keep rule with the tracked policy. Then remove the obsolete
`GAR_ADMIN_KEY_BASE64` environment value and revoke the unused admin key. No
compatibility automation updates policies or credentials.

Upgrades do not migrate images from the former bundled registry. Rebuild every
source-backed service after upgrading. The old `registry-data` Docker volume is
left untouched for explicit operator cleanup after the cutover is verified.

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

### Edge Domain

After signing in as an admin, configure **Edge Domain** under
**Settings → Infrastructure**. This is the canonical hostname used for all
public edge traffic, including HTTP/HTTPS custom domains and direct TCP/UDP
connection strings.

A stable external load balancer with active health checks is the ideal production
solution for proxy failure. Configure each proxy public IPv4 address as an origin,
then point the edge hostname to the load balancer's stable address. A direct `A`
record to one proxy has no ingress failover. Multiple proxy `A` records provide
best-effort DNS distribution, but cached answers may continue sending clients to
an offline proxy.

Custom HTTP/HTTPS subdomains can use a `CNAME` to the edge domain; apex domains
can use `ALIAS` or `ANAME` where supported. Health-aware GeoDNS is an alternative,
but its failover time remains subject to DNS and client caching.

Techulus Cloud only displays the required DNS configuration. It does not create
or update DNS records.

### Automatic Service Subdomains

Configure **Automatic Subdomain Domain** under **Settings → Infrastructure** to
offer generated domains in service Networking settings. Enter only the base
domain, such as `apps.example.com`, without `*.` or a protocol.

Create a wildcard `CNAME` for `*.apps.example.com` that points to the edge domain.

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
