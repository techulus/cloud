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
docker compose -f compose.production.yml up -d --build
```

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
| `ENCRYPTION_KEY` | 32 bytes as 64-character hex string |

### Victoria Logs

| Variable | Description |
|----------|-------------|
| `VL_USERNAME` | Logs service username |
| `VL_PASSWORD` | Logs service password |
| `VL_RETENTION` | Log retention period (default: `7d`) |

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
docker compose -f compose.production.yml down
docker compose -f compose.production.yml up -d --build
```
