# Production Deployment

Docker Compose setup with Traefik for SSL termination via Let's Encrypt.

## Quick Start

```bash
cp .env.example .env
# Edit .env with your values

docker compose -f compose.production.yml up -d --build
```

## Services

| Service | Endpoint |
|---------|----------|
| Web | `https://${ROOT_DOMAIN}` |
| Registry | `https://registry.${ROOT_DOMAIN}` |
| Logs | `https://logs.${ROOT_DOMAIN}` |
| PostgreSQL | Internal only |

## Environment Setup

Generate registry auth:
```bash
htpasswd -nB admin
# Escape $ as $$ in .env
```

## Commands

```bash
docker compose -f compose.production.yml ps
docker compose -f compose.production.yml logs -f
docker compose -f compose.production.yml down
```
