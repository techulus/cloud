# Techulus Cloud - Architecture

## Overview

A stateless container deployment platform with three core principles:
1. **Workloads are disposable** - containers can be killed and recreated at any time
2. **Two node types** - proxy nodes handle public traffic, worker nodes run containers
3. **Networking is private-first** - services communicate over WireGuard mesh, public exposure via proxy nodes

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Control Plane | Next.js (full-stack) | Single deployment, React frontend + API routes |
| Database | Postgres + Drizzle | Simple, no external deps, single file, easy backup |
| Server Agent | Go | Single binary, shells out to Podman |
| Container Runtime | Podman | Docker-compatible, daemonless, bridge networking with static IPs |
| Reverse Proxy | Traefik | Automatic HTTPS via Let's Encrypt, runs on proxy nodes only |
| Private Network | WireGuard (self-managed) | Full mesh, control plane coordinates |
| Service Discovery | Built-in DNS | Agent runs DNS server for .internal domains |
| Agent Communication | Pull-based HTTP | Agent polls for expected state, reports status |

## Node Types

| Type | Traefik | Public Traffic | Containers |
|------|---------|----------------|------------|
| Proxy | ✓ | Handles TLS termination | ✓ |
| Worker | ✗ | None | ✓ |

- **Proxy nodes**: Handle incoming public traffic, TLS termination via HTTP-01 ACME, route to containers via WireGuard
- **Worker nodes**: Run containers only, no public exposure, lighter footprint

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
│                          SERVERS                                 │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │  Proxy Node 1   │  │  Worker Node 1  │  │  Worker Node 2  │ │
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
│  │ │   Traefik   │ │  │ │      -      │ │  │ │      -      │ │ │
│  │ ├─────────────┤ │  │ ├─────────────┤ │  │ ├─────────────┤ │ │
│  │ │  DNS Server │ │  │ │  DNS Server │ │  │ │  DNS Server │ │ │
│  │ ├─────────────┤ │  │ ├─────────────┤ │  │ ├─────────────┤ │ │
│  │ │  WireGuard  │ │  │ │  WireGuard  │ │  │ │  WireGuard  │ │ │
│  │ └─────────────┘ │  │ └─────────────┘ │  │ └─────────────┘ │ │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘ │
│           │                    │                    │          │
│           └────────────────────┴────────────────────┘          │
│                      WireGuard Full Mesh                       │
└─────────────────────────────────────────────────────────────────┘

Public Traffic Flow:
  Internet → DNS → Proxy Node → Traefik (TLS) → WireGuard → Container
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
- Compare expected state vs actual state (containers, DNS, Traefik*, WireGuard)
- If no drift: send status report, stay in IDLE
- If drift detected: snapshot expected state, transition to PROCESSING

*Traefik drift detection only on proxy nodes

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
- **DNS**: Hash of sorted records vs current DNS server config
- **Traefik**: Hash of sorted routes vs current Traefik config (proxy nodes only)
- **WireGuard**: Hash of sorted peers vs current wg0.conf

### Container Reconciliation

Order of operations:
1. Stop orphan containers (no deployment ID)
2. Start containers in "created" or "exited" state
3. Deploy missing containers
4. Redeploy containers with wrong state or image mismatch
5. Update DNS records
6. Update Traefik routes (proxy nodes only)
7. Update WireGuard peers

## Rollout Stages

Deployments go through these stages:

```
pending → pulling → starting → healthy → dns_updating → traefik_updating → stopping_old → running
```

| Stage | Description |
|-------|-------------|
| `pending` | Deployment created, waiting for agent |
| `pulling` | Agent is pulling the container image |
| `starting` | Container started, waiting for health check |
| `healthy` | Health check passed (or no health check) |
| `dns_updating` | DNS records being updated |
| `traefik_updating` | Traefik routes being updated |
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

### DNS Resolution

Each agent runs a built-in DNS server for `.internal` domain resolution:
- Listens on the container gateway IP (e.g., `10.200.1.1`)
- Configures systemd-resolved to forward `.internal` queries
- Records pushed from control plane via expected state

Services resolve via `.internal` domain with round-robin across replicas.

### Traefik (Proxy Nodes Only)

Proxy nodes run Traefik with routes and certificates pushed from control plane:
- Routes configured via file provider in `/etc/traefik/dynamic/routes.yaml`
- Certificates configured via file provider in `/etc/traefik/dynamic/tls.yaml`
- Routes: `subdomain.example.com` → container IPs (via WireGuard mesh)
- TLS: Static certificates managed by control plane
- Challenge route: `/.well-known/acme-challenge/*` → control plane for ACME validation
- Control plane only sends routes and certificates to proxy nodes

Worker nodes do not run Traefik.

### Multiple Proxy Nodes (Geographic Distribution)

The platform supports multiple proxy nodes in different regions with automatic proximity steering:
- Users point custom domains to a single DNS name via GeoDNS (BunnyDNS)
- BunnyDNS routes clients to geographically nearest proxy based on their location
- BunnyDNS health checks automatically failover if a proxy goes down
- All proxies share the same TLS certificates (synced from control plane)

Example:
```
Proxy US:   1.2.3.4
Proxy EU:   5.6.7.8
Proxy SYD:  9.10.11.12

GeoDNS (BunnyDNS):
  example.com → lb.techulus.cloud
  → BunnyDNS steers to nearest proxy based on client geography
  → Returns 1.2.3.4 (US), 5.6.7.8 (EU), or 9.10.11.12 (SYD)
  → Health checks: exclude proxy if down, failover to next nearest

All proxies share same TLS certificates (synced from control plane)
```

ACME challenges work seamlessly because:
- Let's Encrypt validates the domain via single IP (any proxy)
- Challenge hits any proxy node (they're all interchangeable)
- All proxies have identical certificates
- If one proxy goes down, others already have the cert

### Proximity-Aware Load Balancing

Within a proxy node, traffic is distributed to replicas using weighted round-robin:

**Replica Selection Priority:**
1. **Local replicas** (on same proxy server) - weight 5
2. **Remote replicas** (on other proxy servers) - weight 1

This means if a service has 1 local replica and 1 remote replica, the local replica receives ~83% of traffic.

**Traffic Flow:**
```
User (US) 
  → GeoDNS: nearest proxy = US (1.2.3.4)
  → Traefik: weighted round-robin
    - Local replicas (weight 5) ← 83% of traffic
    - Remote replicas (weight 1) ← 17% of traffic (failover)
  → Container
```

Benefits:
- **Low latency**: Requests stay on same proxy when possible
- **Failover**: If local replica fails, automatically uses remote
- **Cost-effective**: Minimizes cross-region traffic

### ACME Certificate Management (Centralized)

Instead of each proxy managing its own ACME certificates, the control plane handles all certificate lifecycle:

**Challenge Flow:**
1. Control plane initiates ACME renewal for expiring certificates
2. Let's Encrypt requests validation: `GET http://domain/.well-known/acme-challenge/{token}`
3. Request hits load balancer → any proxy node (all behind same IP)
4. Traefik matches `PathPrefix(/.well-known/acme-challenge/)` → special challenge route
5. Challenge route (via middleware) rewrites path to `/api/v1/acme/challenge/{token}`
6. Traefik forwards to control plane: `https://control-plane.internal/api/v1/acme/challenge/{token}`
7. Control plane returns keyAuthorization from database
8. Let's Encrypt validates and issues certificate

**Certificate Sync:**
1. Certificate issued and stored in `domain_certificates` table
2. Control plane includes certificates in expected state API response (proxy nodes only)
3. Agent receives certificates, writes to `/etc/traefik/certs/{domain}.crt` and `.key`
4. Agent updates `/etc/traefik/dynamic/tls.yaml` with certificate paths
5. Traefik reloads and serves TLS with new certificates

**Renewal:**
- Cron job checks daily for certificates expiring in 30 days
- Triggers ACME renewal via acme-client library
- Challenge responses served through any proxy node
- New certificates synced to all proxies within agent poll cycle (10 seconds)

### Traffic Flows

**Internal (service-to-service):**
```
Container A (10.200.1.2)
  → DNS: redis.internal → 10.200.2.3
  → Packet to 10.200.2.3
  → Host routes via WireGuard to Server 2
  → Container B (10.200.2.3)
```

**External (public) - Custom Domain:**
```
User domain: example.com (points to proxy IP via A record or CNAME)
  → Internet → Proxy Node public IP
  → Traefik: example.com → 10.200.1.2:80 (TLS terminated)
  → WireGuard tunnel to target node
  → Container (10.200.1.2)
```

**ACME Challenge (Let's Encrypt validation):**
```
Let's Encrypt → HTTP request to example.com/.well-known/acme-challenge/{token}
  → Proxy Node (any of them, all same IP)
  → Traefik matches challenge route (priority 9999)
  → Middleware rewrites path to /api/v1/acme/challenge/{token}
  → Traefik backend: control plane HTTPS
  → Returns keyAuthorization
  → Let's Encrypt validates
```

## Components

### 1. Control Plane (Next.js)

**Responsibilities:**
- User authentication
- Project and service configuration
- WireGuard coordination (assigns subnets, broadcasts peer updates)
- Deployment orchestration (rollouts)
- Certificate lifecycle management (issuance, renewal, sync)
- Serves expected state to agents
- Processes status reports from agents
- Advances rollout stages based on deployment status

**API Endpoints:**
- `GET /api/v1/agent/expected-state` - Returns containers, DNS, Traefik (proxy only), WireGuard, certificates config
- `POST /api/v1/agent/status` - Receives container status, advances rollout stages
- `GET /api/v1/acme/challenge/{token}` - Returns ACME challenge keyAuthorization for Let's Encrypt validation

**Background Jobs (Cron):**
- Every 24h: Check for certificates expiring in 30 days, trigger ACME renewal
- Every 10m: Clean up expired ACME challenge tokens from database

### 2. Server Agent (Go)

**Responsibilities:**
- Polls control plane for expected state
- Manages containers via Podman with static IPs
- Manages local WireGuard interface
- Updates Traefik routes via file provider (proxy nodes only)
- Syncs TLS certificates to disk (proxy nodes only)
- Updates DNS records
- Reports status (resources, public IP, container health)

**Agent Lifecycle:**
1. User creates server in control plane, receives agent token
2. User runs install script (specifies if proxy node)
3. User starts agent with token (and `--proxy` flag if proxy node)
4. Agent generates WireGuard and signing keypairs
5. Agent registers with control plane via HTTP (includes isProxy flag)
6. Control plane assigns subnet, returns WireGuard peers
7. Agent configures WireGuard, container network, DNS server, and Traefik (if proxy)
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
5. **Traefik**: Only entry point for public traffic (proxy nodes only)

**Registration Token:**
- One-time-use token for initial registration
- Invalidated after successful registration

**Request Signing:**
- Agent signs request body with HMAC-SHA256
- Includes timestamp to prevent replay attacks
- Control plane verifies using stored server secret
