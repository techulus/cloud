# Techulus Cloud

A stateless container deployment platform with private-first networking.

> ⚠️ **Experimental**: This is a very experimental project and is nowhere near production ready. Use at your own risk.

## Features

- **Container Orchestration**: Deploy containers via Podman with automatic port binding
- **WireGuard Mesh**: Private networking between all servers
- **Automatic HTTPS**: Caddy-based proxy with on-demand TLS via DNS-01 (Cloudflare)
- **Simple Architecture**: Next.js control plane, Go agents, PostgreSQL database

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed architecture documentation.

## TODO

- [x] Replace HTTP polling with gRPC bidirectional streaming
- [x] Distributed Caddy
- [x] Per-machine subnet allocation
- [x] Local DNS on each machine
- [x] Health checks
- [x] Secrets
- [ ] Deploy Logs
- [ ] HTTP Logs
- [ ] Rolling updates
- [ ] GitHub deployments
- [ ] Volumes
