# Techulus Cloud - Architecture

## Overview

A stateless container deployment platform with three core principles:
1. **Workloads are disposable** - containers can be killed and recreated at any time
2. **Machines are peers, not pets** - no special server roles (except the proxy)
3. **Networking is private-first** - services communicate over WireGuard, exposure is deliberate

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Control Plane | Next.js (full-stack) | Single deployment, React frontend + API routes |
| Database | SQLite + Drizzle | Simple, no external deps, single file, easy backup |
| Server Agent | Go | Single binary, shells out to Podman |
| Container Runtime | Podman | Docker-compatible, daemonless, easy IP-bound port mapping |
| Reverse Proxy | Caddy | Automatic HTTPS, simple config |
| Private Network | WireGuard (self-managed) | Control plane coordinates, agents manage local config |
| Agent Communication | Polling | Simpler, works through NAT/firewalls |

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         CONTROL PLANE                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │   Next.js (App Router + API Routes + SQLite/Drizzle)     │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTPS (polling)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌─────────────────┐                                           │
│  │  PROXY SERVER   │  ◄── Dedicated, no workloads              │
│  │  ┌───────────┐  │                                           │
│  │  │   Caddy   │  │  ◄── Custom domains point here            │
│  │  └───────────┘  │                                           │
│  │  ┌───────────┐  │                                           │
│  │  │ WireGuard │  │  ◄── Routes to workers via mesh           │
│  │  └───────────┘  │                                           │
│  └────────┬────────┘                                           │
│           │                                                     │
│           │ WireGuard Mesh (10.x.x.x)                          │
│           │                                                     │
│  ┌────────┴────────────────────────────────────────────┐       │
│  │                   WORKER SERVERS                     │       │
│  │                                                      │       │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │       │
│  │  │  Worker A   │  │  Worker B   │  │  Worker C   │ │       │
│  │  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │ │       │
│  │  │ │  Agent  │ │  │ │  Agent  │ │  │ │  Agent  │ │ │       │
│  │  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │ │       │
│  │  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │ │       │
│  │  │ │ Podman  │ │  │ │ Podman  │ │  │ │ Podman  │ │ │       │
│  │  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │ │       │
│  │  │ ┌─────────┐ │  │ ┌─────────┐ │  │ ┌─────────┐ │ │       │
│  │  │ │WireGuard│ │  │ │WireGuard│ │  │ │WireGuard│ │ │       │
│  │  │ └─────────┘ │  │ └─────────┘ │  │ └─────────┘ │ │       │
│  │  └─────────────┘  └─────────────┘  └─────────────┘ │       │
│  └──────────────────────────────────────────────────────┘       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Control Plane (Next.js + Convex)

**Responsibilities:**
- User authentication
- Project and service configuration
- WireGuard key coordination (stores public keys, assigns IPs)
- Deployment orchestration (queues work for agents)
- Proxy configuration management

**Server Health Detection:**
- Agent polling IS the heartbeat - each poll updates `lastHeartbeat`
- Server is "online" if `lastHeartbeat > (now - threshold)`
- Server is "offline" if `lastHeartbeat < (now - threshold)`
- No scheduled jobs - control plane stays simple

**Offline Server Recovery:**
- When a server goes offline, control plane detects stale heartbeat
- All deployments on that server are marked as "failed"
- Workloads are rescheduled to healthy servers
- Failed server can be brought back online by restarting the agent

**Work Queue Timeout:**
- Jobs in `processing` state have a 5-minute timeout
- When an agent polls, control plane checks for stuck jobs where `now - startedAt > 5 minutes`
- Stuck jobs are reset to `pending` with `attempts` incremented
- After 3 failed attempts, job is marked as `failed` permanently
- This handles agent crashes without requiring scheduled cleanup jobs

### 2. Server Agent (Go)

**Responsibilities:**
- Polls control plane for work (deployments, config changes)
- Manages containers via Podman (pull images, start/stop containers)
- Manages local WireGuard interface
- Reports container status, resource usage, logs
- Binds container ports to WireGuard IP only (not exposed on public interface)

**Agent Lifecycle:**
1. User creates server in control plane, receives agent token
2. User manually installs agent binary + systemd service on target machine with token
3. Agent generates WireGuard keypair locally
4. Agent registers with control plane (sends public key, token validates registration)
5. Control plane assigns WireGuard IP and peer configurations
6. Agent configures local WireGuard interface
7. Agent begins polling for work

### 3. WireGuard Mesh (Self-Managed)

**Design:**
- Each server gets a unique WireGuard IP (e.g., 10.100.x.x)
- Control plane is the source of truth for peer configs
- Full mesh topology: every server can reach every other server
- Services communicate directly via WireGuard IPs regardless of which server they run on

**Scalability:**
- Full mesh works well for <10 servers
- At higher scale (20+ servers), consider hub-and-spoke: proxy becomes hub, all inter-service traffic routes through proxy's WireGuard interface
- Future enhancement: partial mesh with backbone topology

**Peer Updates (via work queue):**
- New server joins → control plane queues `update_wireguard` for all existing servers
- Server removed → control plane queues `update_wireguard` for remaining servers
- Agents pick up the work item on next poll, update their local WireGuard config

**Key Management:**
- Each agent generates its own keypair locally
- Public keys stored in Convex
- Private keys never leave the server

### 4. Proxy Server (Platform Infrastructure)

**Key Design Decision**: Proxy is **platform infrastructure**, not a team resource. It's not in the `servers` table.

**Why separate?**
- Routes traffic for ALL teams, not owned by any team
- Isolation: proxy failure doesn't kill workloads, workload failure doesn't kill ingress
- Lightweight: can be a small/cheap server
- Security: only server with public ports open

**High Availability (v1 Limitation):**
- Proxy server is a single point of failure for external traffic
- v1 design accepts this limitation for simplicity
- v2+ should implement proxy HA with load balancing across multiple proxy instances

**Responsibilities:**
- Terminates SSL for all exposed services
- Routes traffic to correct backend via WireGuard mesh
- Handles custom domain configuration
- Automatic certificate management (Let's Encrypt)

**Routing Logic:**
- Domain → Service lookup (Caddy config generated from control plane)
- Service → List of (WireGuard IP:port) backends
- Load balance across healthy backends (round-robin)

**What runs on the proxy server:**
- Caddy (reverse proxy)
- WireGuard (to reach worker servers)
- Config sync process (pulls routes from control plane, updates Caddy)

**Configuration:**
- Proxy details (IP, WireGuard keys) stored as platform config, not in `servers` table
- Could be environment variables or a separate platform settings table

## Data Model (Drizzle Schema)

```typescript
servers
  id
  name
  publicIp
  wireguardIp
  wireguardPublicKey
  status: pending | online | offline | unknown
  lastHeartbeat
  resourcesCpu
  resourcesMemory
  resourcesDisk
  agentToken (nullable)
  tokenCreatedAt (nullable)
  tokenUsedAt (nullable)

projects
  id
  name
  slug

services
  id
  projectId -> projects.id
  name
  image
  port
  replicas
  exposedDomain (nullable)

secrets
  id
  serviceId -> services.id
  key
  encryptedValue

deployments
  id
  serviceId -> services.id
  serverId -> servers.id
  containerId
  status: pending | pulling | running | stopped | failed
  wireguardIp
  port

workQueue
  id
  serverId -> servers.id
  type: deploy | stop | update_wireguard
  payload (JSON)
  status: pending | processing | completed | failed
  createdAt
  startedAt (nullable)
  attempts (default: 0)

proxyRoutes
  id
  domain
  serviceId -> services.id
  sslEnabled
```

## Workflows

### 1. Server Registration

```
User                    Control Plane              Server Agent
  │                          │                          │
  │ Add server (name, IP)    │                          │
  │─────────────────────────►│                          │
  │                          │ Generate agent token     │
  │◄─────────────────────────│                          │
  │                          │                          │
  │ Install agent with token │                          │
  │─────────────────────────────────────────────────────►
  │                          │                          │
  │                          │◄─── Register (pubkey) ───│
  │                          │                          │
  │                          │── Assign WG IP, peers ──►│
  │                          │                          │
  │                          │    Configure WireGuard   │
  │                          │                          │
  │                          │◄────── Heartbeat ────────│
```

### 2. Service Deployment

```
User                    Control Plane              Server Agent(s)
  │                          │                          │
  │ Create service           │                          │
  │ (image, port, replicas)  │                          │
  │─────────────────────────►│                          │
  │                          │                          │
  │                          │ Select servers           │
  │                          │ (placement strategy)     │
  │                          │                          │
  │                          │ Queue work items         │
  │                          │                          │
  │                          │◄─────── Poll ────────────│
  │                          │                          │
  │                          │──── Work: deploy ───────►│
  │                          │                          │
  │                          │    Pull image            │
  │                          │    Start container       │
  │                          │                          │
  │                          │◄── Status: running ──────│
  │                          │                          │
  │                          │ Update proxy routes      │
  │◄── Deployment ready ─────│                          │
```

### 3. Traffic Flow (External Request)

```
Internet                 Master Proxy              Backend Servers
   │                         │                          │
   │ HTTPS request           │                          │
   │ (api.example.com)       │                          │
   │────────────────────────►│                          │
   │                         │                          │
   │                         │ Lookup route             │
   │                         │ (domain → backends)      │
   │                         │                          │
   │                         │─── Forward via WG ──────►│
   │                         │   (10.100.1.5:8080)      │
   │                         │                          │
   │                         │◄─────── Response ────────│
   │◄────────────────────────│                          │
```

## Security Model

1. **Agent Authentication**: WireGuard key signature (see below)
2. **WireGuard**: All inter-server traffic encrypted
3. **No Public Ports**: Containers only bind to WireGuard interface
4. **Secrets**: Env vars encrypted at rest in Convex, decrypted by agent

**Registration Token:**
- One-time-use token for initial server registration only
- Expires 24 hours after creation
- Invalidated immediately after successful registration

**Agent Authentication (Ongoing):**
- Agent signs poll requests with its WireGuard private key
- Control plane verifies signature using stored public key
- No additional secrets to manage - uses existing keypair

**Agent Identity Binding:**
- WireGuard public key is locked to server record after registration
- If public key changes on heartbeat:
  - Server status → `unknown`
  - Workloads on that server paused
  - Requires manual approval to accept new key
- Detects server replacement, agent reinstalls, or compromise

## Design Decisions

| Decision | Choice |
|----------|--------|
| Placement Strategy | Manual server selection, or capacity-based bidding (servers report available resources, control plane selects best fit) |
| Health Checks | Agent-reported only (agent monitors containers, reports to control plane) |
| Logs | Real-time streaming only (no persistence) |
| Auth | Better Auth (self-hosted, handles users/sessions) |
| Secrets | Platform master key, secrets encrypted in DB, decrypted by agent |
| Container Updates | Rolling update (one replica at a time, zero downtime) |

## Secrets Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     CONTROL PLANE                           │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Platform Master Key (passed to agent during install) │   │
│  │                                                     │   │
│  │ Secrets stored encrypted per service:               │   │
│  │   service-abc: { DB_URL: enc(...), API_KEY: enc(...) } │
│  │   service-xyz: { TOKEN: enc(...) }                  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼
         Agent receives encrypted secrets via work queue,
         decrypts locally using master key (from install),
         passes decrypted values to container as env vars
```

**Master Key Management:**
- Master key provided to agent during installation (via agent binary or config file)
- Key is stored locally on agent server (protected by OS file permissions)
- Agent uses key to decrypt secrets at runtime
- Master key never transmitted over the network after initial setup

## Project Structure

```
techulus-cloud/
├── web/                        # Next.js control plane
│   ├── app/
│   │   ├── api/               # API routes for agent polling
│   │   └── dashboard/         # Dashboard pages
│   ├── db/
│   │   ├── schema.ts          # Drizzle schema
│   │   └── index.ts           # DB connection
│   └── lib/
│
├── agent/                      # Go server agent
│   ├── cmd/
│   │   └── agent/
│   │       └── main.go
│   ├── internal/
│   │   ├── api/               # Control plane client
│   │   ├── podman/            # Container management via Podman CLI
│   │   ├── wireguard/         # WG interface management
│   │   └── crypto/            # Ed25519 key management
│   └── go.mod
│
└── docs/
    └── ARCHITECTURE.md
```
