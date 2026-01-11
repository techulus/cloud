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

- [x] HTTP polling for agent communication
- [x] Traefik reverse proxy
- [x] Per-machine subnet allocation
- [x] Local DNS on each machine
- [x] Health checks
- [x] Secrets
- [x] Volumes
- [x] Deploy Logs
- [x] GitHub deployments
- [x] HTTP Logs
- [x] Rolling updates
- [ ] Volume backups
- [ ] TCP / L4 proxying
