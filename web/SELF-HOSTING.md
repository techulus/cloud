# Self-Hosting Guide

Production deployment using Docker Compose with Traefik for automatic SSL via Let's Encrypt.

## Prerequisites

- Docker and Docker Compose
- A domain name with DNS configured
- Ports 80 and 443 available

## Quick Start

```bash
cd deployment
cp .env.example .env
```

Edit `.env` with your values, then:

```bash
docker compose -f compose.production.yml up -d --build --remove-orphans
```

From the `deployment/` directory, create the first admin user after the
database migration completes:

```bash
docker compose -f compose.production.yml run --rm web node scripts/admin.mjs --create admin@example.com
```

The command runs inside the Docker image and prints a random password once.
Store it, sign in with that admin account, then invite developers and readers
from Settings. The app blocks authenticated role-gated access until one admin
user exists.

To reset the existing admin password, run:

```bash
docker compose -f compose.production.yml run --rm web node scripts/admin.mjs --reset-password admin@example.com
```

The reset command refuses to run unless the provided email is the only admin
user.

Production hosts should cap Docker container logs in `/etc/docker/daemon.json`.
For release deployments, prefer versioned or digest-pinned image references over
mutable tags such as `latest` or `tip`.

## Services

| Service | Endpoint |
|---------|----------|
| Web | `https://${ROOT_DOMAIN}` |
| Registry | `https://registry.${ROOT_DOMAIN}` |
| Logs | `https://logs.${ROOT_DOMAIN}` |
| PostgreSQL | Internal only |

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `ROOT_DOMAIN` | Your domain (e.g., `example.com`) |
| `ACME_EMAIL` | Email for Let's Encrypt certificates |
| `POSTGRES_USER` | PostgreSQL username |
| `POSTGRES_PASSWORD` | PostgreSQL password |
| `POSTGRES_DB` | PostgreSQL database name |
| `DATABASE_URL` | Full connection string (e.g., `postgres://user:pass@postgres:5432/db`) |
| `BETTER_AUTH_SECRET` | Secret key for authentication |
| `ENCRYPTION_KEY` | 32 bytes as 64-character hex string. Required unless AWS KMS BYOK is configured. |
| `ENCRYPTION_KMS_KEY_ARN` | Optional full ARN of a symmetric AWS KMS key. Enables BYOK. |
| `AWS_REGION` | Required with `ENCRYPTION_KMS_KEY_ARN`. |

For KMS BYOK, run the dedicated control plane in AWS with an instance profile or task role. The role needs `kms:GenerateDataKey`, `kms:Encrypt`, `kms:Decrypt`, and `kms:DescribeKey`. Do not put static AWS credentials in `.env`.

The KMS key can be in another AWS account. For direct cross-account access, grant the control-plane role access in both the customer's KMS key policy and the role's identity policy. Scope cryptographic operations to the exact key and the `techulus:purpose=service-secret-dek` encryption context. The application uses its existing role credentials and does not call STS `AssumeRole`. Compute agents need no KMS permissions. See the installation documentation for policy examples.

On a fresh KMS installation, omit `ENCRYPTION_KEY`. To migrate existing data, configure KMS while retaining `ENCRYPTION_KEY` for one restart. Verify an existing secret, then remove the raw key and restart every web replica. If a wrapped key already exists, a remaining `ENCRYPTION_KEY` must match it or encryption operations fail closed. The wrapped data encryption key is stored in PostgreSQL, so database recovery also requires access to the same KMS key.

### Victoria Logs

| Variable | Description |
|----------|-------------|
| `VL_USERNAME` | Logs service username |
| `VL_PASSWORD` | Logs service password |
| `VL_RETENTION` | Log retention period (default: `7d`) |

### Victoria Metrics

| Variable | Description |
|----------|-------------|
| `VM_USERNAME` | Metrics service username |
| `VM_PASSWORD` | Metrics service password |
| `VM_RETENTION` | Metrics retention period (default: `30d`) |

### Registry

| Variable | Description |
|----------|-------------|
| `REGISTRY_AUTH` | htpasswd format auth string |
| `REGISTRY_URL` | Registry URL for agents |
| `REGISTRY_USERNAME` | Registry username for agents |
| `REGISTRY_PASSWORD` | Registry password for agents |
| `REGISTRY_INSECURE` | Set to `true` for insecure registry |

Generate registry auth:
```bash
htpasswd -nB admin
```
Escape `$` as `$$` in the `.env` file.

### GitHub Integration (Optional)

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret |

## Commands

```bash
docker compose -f compose.production.yml ps
docker compose -f compose.production.yml logs -f
docker compose -f compose.production.yml logs migrate
docker compose -f compose.production.yml run --rm web node scripts/admin.mjs --create admin@example.com
docker compose -f compose.production.yml run --rm web node scripts/admin.mjs --reset-password admin@example.com
docker compose -f compose.production.yml down --remove-orphans
docker compose -f compose.production.yml up -d --build --remove-orphans
```
