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
| Server Agent | Go | Single binary, excellent containerd libraries |
| Container Runtime | containerd | Lightweight, battle-tested, used by K8s |
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
│  │  │ │containerd│ │  │ │containerd│ │  │ │containerd│ │ │       │
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
- No scheduled jobs - control plane stays simple

### 2. Server Agent (Go)

**Responsibilities:**
- Polls control plane for work (deployments, config changes)
- Manages local containerd (pull images, start/stop containers)
- Manages local WireGuard interface
- Reports container status, resource usage, logs
- Exposes container ports on WireGuard IP

**Agent Lifecycle:**
1. Install agent binary + systemd service
2. Agent generates WireGuard keypair
3. Agent registers with control plane (sends public key, gets WireGuard IP)
4. Agent joins WireGuard mesh
5. Agent polls for work

### 3. WireGuard Mesh (Self-Managed)

**Design:**
- Each server gets a unique WireGuard IP (e.g., 10.100.x.x)
- Control plane is the source of truth for peer configs
- Full mesh topology: every server can reach every other server

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
  status: pending | online | offline
  lastHeartbeat
  resourcesCpu
  resourcesMemory
  resourcesDisk

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

1. **Agent Authentication**: Each agent gets a unique token on registration
2. **WireGuard**: All inter-server traffic encrypted
3. **No Public Ports**: Containers only bind to WireGuard interface
4. **Secrets**: Env vars encrypted at rest in Convex, decrypted by agent

## Design Decisions

| Decision | Choice |
|----------|--------|
| Placement Strategy | Resource-based by default, with manual server override |
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
│  │ Platform Master Key (env var or secure storage)     │   │
│  │                                                     │   │
│  │ Secrets stored encrypted per service:               │   │
│  │   service-abc: { DB_URL: enc(...), API_KEY: enc(...) } │
│  │   service-xyz: { TOKEN: enc(...) }                  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    Agent receives encrypted secrets,
                    decrypts using master key,
                    passes to container as env vars
```

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
│   │   ├── containerd/        # Container management
│   │   ├── wireguard/         # WG interface management
│   │   └── worker/            # Work execution
│   └── go.mod
│
└── docs/
    └── ARCHITECTURE.md
```
