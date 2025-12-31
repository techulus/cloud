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
| Database | Postgres + Drizzle | Simple, no external deps, single file, easy backup |
| Server Agent | Go | Single binary, shells out to Podman |
| Container Runtime | Podman | Docker-compatible, daemonless, bridge networking with static IPs |
| Reverse Proxy | Caddy | Automatic HTTPS, runs on every server |
| Private Network | WireGuard (self-managed) | Full mesh, control plane coordinates |
| Service Discovery | dnsmasq | Local DNS on each server for .internal domains |
| Agent Communication | Pull-based HTTP | Agent polls for expected state, reports status |

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         CONTROL PLANE                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │   Next.js (App Router + API Routes + Postgres)           │  │
│  │                                                          │  │
│  │   GET /api/v1/agent/expected-state  (agent polls)        │  │
│  │   POST /api/v1/agent/status         (agent reports)      │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTPS (poll every 10s)
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

## Agent State Machine

The agent uses a two-state machine to prevent race conditions during reconciliation:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│    ┌─────────┐                         ┌────────────┐          │
│    │  IDLE   │───drift detected───────▶│ PROCESSING │          │
│    │ (poll)  │◀────────────────────────│  (no poll) │          │
│    └─────────┘    done/failed/timeout  └────────────┘          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### IDLE State
- Poll control plane every 10 seconds for expected state
- Compare expected state vs actual state (containers, DNS, Caddy, WireGuard)
- If no drift: send status report, stay in IDLE
- If drift detected: snapshot expected state, transition to PROCESSING

### PROCESSING State
- Stop polling (use the expected state snapshot)
- Apply ONE change at a time with verification
- After each change, re-check drift
- If no drift remains: transition to IDLE
- Timeout after 5 minutes: force transition to IDLE
- Always send status report before transitioning to IDLE

### Drift Detection

The agent detects drift using hash comparisons:
- **Containers**: Missing, orphaned, wrong state, or image mismatch
- **DNS**: Hash of sorted records vs current dnsmasq config
- **Caddy**: Hash of sorted routes vs current Caddy config
- **WireGuard**: Hash of sorted peers vs current wg0.conf

### Container Reconciliation

Order of operations:
1. Stop orphan containers (no deployment ID)
2. Start containers in "created" or "exited" state
3. Deploy missing containers
4. Redeploy containers with wrong state or image mismatch
5. Update DNS records
6. Update Caddy routes
7. Update WireGuard peers

## Rollout Stages

Deployments go through these stages:

```
pending → pulling → starting → healthy → dns_updating → caddy_updating → stopping_old → running
```

| Stage | Description |
|-------|-------------|
| `pending` | Deployment created, waiting for agent |
| `pulling` | Agent is pulling the container image |
| `starting` | Container started, waiting for health check |
| `healthy` | Health check passed (or no health check) |
| `dns_updating` | DNS records being updated |
| `caddy_updating` | Caddy routes being updated |
| `stopping_old` | Old deployment containers being stopped |
| `running` | Deployment complete and serving traffic |

Special states:
- `unknown`: Agent stopped reporting this deployment (container may still exist)
- `stopped`: Container explicitly stopped
- `failed`: Deployment failed (health check, etc.)
- `rolled_back`: Rollout failed, reverted to previous deployment

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

Containers get static IPs assigned by the control plane:
```bash
podman run -d \
  --name service-deployment \
  --network techulus \
  --ip 10.200.1.2 \
  --label techulus.deployment.id=<deployment-id> \
  --label techulus.service.id=<service-id> \
  traefik/whoami
```

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
- Public routes: `subdomain.example.com` → container IPs

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
  → Caddy: app.example.com → 10.200.1.2:80
  → WireGuard tunnel to Server 1
  → Container (10.200.1.2)
```

## Components

### 1. Control Plane (Next.js)

**Responsibilities:**
- User authentication
- Project and service configuration
- WireGuard coordination (assigns subnets, broadcasts peer updates)
- Deployment orchestration (rollouts)
- Serves expected state to agents
- Processes status reports from agents
- Advances rollout stages based on deployment status

**API Endpoints:**
- `GET /api/v1/agent/expected-state` - Returns containers, DNS, Caddy, WireGuard config
- `POST /api/v1/agent/status` - Receives container status, advances rollout stages

### 2. Server Agent (Go)

**Responsibilities:**
- Polls control plane for expected state
- Manages containers via Podman with static IPs
- Manages local WireGuard interface
- Updates Caddy routes via admin API
- Updates dnsmasq records
- Reports status (resources, public IP, container health)

**Agent Lifecycle:**
1. User creates server in control plane, receives agent token
2. User runs install script for dependencies (WireGuard, Podman, Caddy, dnsmasq)
3. User starts agent with token
4. Agent generates WireGuard and signing keypairs
5. Agent registers with control plane via HTTP
6. Control plane assigns subnet, returns WireGuard peers
7. Agent configures WireGuard, container network, dnsmasq
8. Agent enters IDLE state, begins polling

### 3. Container Labels

Containers are tracked via Podman labels:
- `techulus.deployment.id` - Links container to deployment record
- `techulus.service.id` - Links container to service
- `techulus.service.name` - Human-readable service name

## Security Model

1. **Agent Authentication**: HMAC signatures on all HTTP requests
2. **Request Signing**: Body + timestamp signed with server-specific secret
3. **WireGuard**: All inter-server traffic encrypted
4. **No Public Ports on Containers**: Only reachable via WireGuard mesh
5. **Caddy**: Only entry point for public traffic

**Registration Token:**
- One-time-use token for initial registration
- Invalidated after successful registration

**Request Signing:**
- Agent signs request body with HMAC-SHA256
- Includes timestamp to prevent replay attacks
- Control plane verifies using stored server secret
