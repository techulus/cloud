# Techulus Cloud - Architecture

## Overview

A stateless container deployment platform with three core principles:
1. **Workloads are disposable** - containers can be killed and recreated at any time
2. **Machines are peers** - all servers are equal, no special roles
3. **Networking is private-first** - services communicate over WireGuard mesh, public exposure via Caddy

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Control Plane | Next.js (full-stack) | Single deployment, React frontend + API routes |
| Database | SQLite + Drizzle | Simple, no external deps, single file, easy backup |
| Server Agent | Go | Single binary, shells out to Podman |
| Container Runtime | Podman | Docker-compatible, daemonless, bridge networking with static IPs |
| Reverse Proxy | Caddy | Automatic HTTPS, runs on every server |
| Private Network | WireGuard (self-managed) | Full mesh, control plane coordinates |
| Service Discovery | dnsmasq | Local DNS on each server for .internal domains |
| Agent Communication | gRPC streaming | Bidirectional, real-time updates |

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         CONTROL PLANE                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │   Next.js (App Router + API Routes + gRPC + SQLite)      │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ gRPC (bidirectional streaming)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        WORKER SERVERS                           │
│  (All servers are equal - each runs Caddy, dnsmasq, Podman)    │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │    Server 1     │  │    Server 2     │  │    Server 3     │ │
│  │                 │  │                 │  │                 │ │
│  │ WG: 10.100.1.1  │  │ WG: 10.100.2.1  │  │ WG: 10.100.3.1  │ │
│  │ Containers:     │  │ Containers:     │  │ Containers:     │ │
│  │  10.200.1.2-254 │  │  10.200.2.2-254 │  │  10.200.3.2-254 │ │
│  │                 │  │                 │  │                 │ │
│  │ ┌─────────────┐ │  │ ┌─────────────┐ │  │ ┌─────────────┐ │ │
│  │ │    Agent    │ │  │ │    Agent    │ │  │ │    Agent    │ │ │
│  │ ├─────────────┤ │  │ ├─────────────┤ │  │ ├─────────────┤ │ │
│  │ │   Podman    │ │  │ │   Podman    │ │  │ │   Podman    │ │ │
│  │ ├─────────────┤ │  │ ├─────────────┤ │  │ ├─────────────┤ │ │
│  │ │    Caddy    │ │  │ │    Caddy    │ │  │ │    Caddy    │ │ │
│  │ ├─────────────┤ │  │ ├─────────────┤ │  │ ├─────────────┤ │ │
│  │ │   dnsmasq   │ │  │ │   dnsmasq   │ │  │ │   dnsmasq   │ │ │
│  │ ├─────────────┤ │  │ ├─────────────┤ │  │ ├─────────────┤ │ │
│  │ │  WireGuard  │ │  │ │  WireGuard  │ │  │ │  WireGuard  │ │ │
│  │ └─────────────┘ │  │ └─────────────┘ │  │ └─────────────┘ │ │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘ │
│           │                    │                    │          │
│           └────────────────────┴────────────────────┘          │
│                      WireGuard Full Mesh                       │
└─────────────────────────────────────────────────────────────────┘
```

## Networking

### IP Address Scheme

| Range | Purpose |
|-------|---------|
| `10.100.X.1` | WireGuard IP for server X (host mesh) |
| `10.200.X.2-254` | Container IPs on server X |

Where X = server's subnet ID (1-255).

### WireGuard Mesh (Host-to-Host)

Each server gets a `/24` subnet for routing:
- Server 1: `10.100.1.0/24` → WireGuard IP: `10.100.1.1`
- Server 2: `10.100.2.0/24` → WireGuard IP: `10.100.2.1`

Full mesh topology - every server peers with every other server. AllowedIPs includes both WireGuard and container subnets:
```
AllowedIPs = 10.100.2.0/24, 10.200.2.0/24
```

### Container Network (Per-Server)

Each server has a Podman bridge network:
```bash
podman network create \
  --driver bridge \
  --subnet 10.200.1.0/24 \
  --gateway 10.200.1.1 \
  --disable-dns \
  techulus
```

Containers get static IPs:
```bash
podman run -d \
  --name whoami-1 \
  --network techulus \
  --ip 10.200.1.2 \
  traefik/whoami
```

No port mappings needed - containers are directly reachable at their IP.

### DNS Resolution (dnsmasq)

Each server runs dnsmasq with records pushed from control plane:
```
/etc/dnsmasq.d/internal.conf:
address=/whoami.internal/10.200.1.2
address=/whoami.internal/10.200.2.2
address=/redis.internal/10.200.1.3
```

Services resolve via `.internal` domain with round-robin across replicas.

### Caddy (Distributed Reverse Proxy)

Every server runs Caddy with identical routes pushed from control plane:
- Internal routes: `service.internal` → container IPs (via WireGuard mesh)
- Public routes: `subdomain.techulus.app` → container IPs

Any server can handle any request - if the container is remote, traffic routes via WireGuard.

### Traffic Flows

**Internal (service-to-service):**
```
Container A (10.200.1.2)
  → DNS: redis.internal → 10.200.2.3
  → Packet to 10.200.2.3
  → Host routes via WireGuard to Server 2
  → Container B (10.200.2.3)
```

**External (public):**
```
Internet → DNS round-robin → Server 2 public IP
  → Caddy: test.techulus.app → 10.200.1.2:80
  → WireGuard tunnel to Server 1
  → Container (10.200.1.2)
```

## Components

### 1. Control Plane (Next.js + gRPC)

**Responsibilities:**
- User authentication
- Project and service configuration
- WireGuard coordination (assigns subnets, broadcasts peer updates)
- Deployment orchestration (work queue)
- Pushes Caddy routes and DNS records to all agents

**gRPC Communication:**
- Bidirectional streaming with all connected agents
- Pushes work items, Caddy config, DNS config in real-time
- Receives status updates, work completion, heartbeats

### 2. Server Agent (Go)

**Responsibilities:**
- Maintains gRPC stream with control plane
- Manages containers via Podman with static IPs
- Manages local WireGuard interface
- Runs Caddy and updates routes on push
- Runs dnsmasq and updates records on push
- Reports status (resources, public IP)

**Agent Lifecycle:**
1. User creates server in control plane, receives agent token
2. User runs install script for dependencies (WireGuard, Podman, Caddy, dnsmasq)
3. User starts agent with token
4. Agent generates WireGuard and signing keypairs
5. Agent registers with control plane via HTTP
6. Control plane assigns subnet, returns WireGuard peers
7. Agent configures WireGuard, container network, dnsmasq
8. Agent connects via gRPC for ongoing communication

### 3. Work Queue

Jobs dispatched to agents via gRPC:
- `deploy` - Pull image, start container with IP
- `stop` - Stop and remove container
- `update_wireguard` - Update WireGuard peers

Timeout handling:
- Jobs in `processing` state timeout after 5 minutes
- Reset to `pending` with attempts incremented
- After 3 attempts, marked as `failed`

## Security Model

1. **Agent Authentication**: Ed25519 signatures on all gRPC messages
2. **Sequence Numbers**: Replay attack prevention
3. **WireGuard**: All inter-server traffic encrypted
4. **No Public Ports on Containers**: Only reachable via WireGuard mesh
5. **Caddy**: Only entry point for public traffic

**Registration Token:**
- One-time-use token for initial registration
- Invalidated after successful registration

**Message Signing:**
- Agent signs all messages with Ed25519 private key
- Control plane verifies using stored public key
- Sequence numbers prevent replay attacks
