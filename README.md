# Techulus Cloud

A stateless container deployment platform with private-first networking.

> ⚠️ **Experimental**: This is a very experimental project and is nowhere near production ready. Use at your own risk.

## Features

- **Container Orchestration**: Deploy containers via Podman with automatic port binding
- **WireGuard Mesh**: Private networking between all servers
- **Automatic HTTPS**: Traefik-based proxy with automatic TLS via Let's Encrypt
- **Simple Architecture**: Next.js control plane, Go agents, PostgreSQL database

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed architecture documentation.

## TODO

- Managed Database: Deploy standalone databases (PostgreSQL, MySQL, MongoDB, Redis, MariaDB) with automated configuration and management
- Notifications: Alert channels (Slack, Discord, Telegram, Email, Webhooks) for deployment success/failure and system events
- Templates? Pre-configured templates for popular apps
