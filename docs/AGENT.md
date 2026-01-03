# Agent Architecture

The agent runs on servers and reconciles expected state from the control plane.

## Node Types

The agent supports two modes:

| Type | Flag | Caddy | Description |
|------|------|-------|-------------|
| Worker | (default) | ✗ | Runs containers only |
| Proxy | `--proxy` | ✓ | Handles TLS and public traffic |

## State Machine

Two-state machine for reconciliation:

```
┌─────────┐                         ┌────────────┐
│  IDLE   │───drift detected───────▶│ PROCESSING │
│ (poll)  │◀────────────────────────│  (no poll) │
└─────────┘    done/failed/timeout  └────────────┘
```

### IDLE State
- Polls control plane every 10 seconds for expected state
- Compares expected vs actual state
- If drift detected: transitions to PROCESSING

### PROCESSING State
- Uses snapshot of expected state (no re-polling)
- Applies ONE change at a time:
  1. Stop orphan containers (no deployment ID)
  2. Start containers in "created" or "exited" state
  3. Deploy missing containers
  4. Redeploy containers with wrong image
  5. Update DNS records
  6. Update Caddy routes (proxy nodes only)
  7. Update WireGuard peers
- Timeout: 5 minutes max
- Always reports status before returning to IDLE

## Drift Detection

Uses hash comparisons for deterministic drift detection:
- Containers: Missing, orphaned, wrong state, or image mismatch
- DNS: Hash of sorted records
- Caddy: Hash of sorted routes (proxy nodes only)
- WireGuard: Hash of sorted peers

## Container Labels

The agent tracks containers using Podman labels:

| Label | Description |
|-------|-------------|
| `techulus.deployment.id` | Links container to deployment record |
| `techulus.service.id` | Links container to service |
| `techulus.service.name` | Human-readable service name |

Containers without `techulus.deployment.id` are considered orphans and will be cleaned up.

## Command Line Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | (required) | Control plane URL |
| `--token` | | Registration token (required for first run) |
| `--data-dir` | `/var/lib/techulus-agent` | Data directory for agent state |
| `--logs-endpoint` | | VictoriaLogs endpoint for log shipping |
| `--proxy` | `false` | Run as proxy node (handles TLS/public traffic) |

## Build System

Agents can build container images from GitHub sources:

1. Agent polls for pending builds
2. Claims build (prevents other agents from picking it up)
3. Clones repository using GitHub App installation token
4. Runs Railpack to generate build plan (or uses existing Dockerfile)
5. Builds image via BuildKit
6. Pushes to registry
7. Updates build status

Build logs are streamed to VictoriaLogs in real-time.

## Work Queue

Agents process work queue items for operations that can't be expressed via expected state:

| Type | Description |
|------|-------------|
| `restart` | Restart a specific container |
| `stop` | Stop a specific container |
| `force_cleanup` | Force remove containers for a service |
| `cleanup_volumes` | Remove volume directories for a service |
| `deploy` | Handled via expected state reconciliation |

## Proxy vs Worker Behavior

### Proxy Node (`--proxy`)
- Runs Caddy for TLS termination
- Receives Caddy routes from control plane
- Handles public traffic and routes to containers via WireGuard
- Collects and ships Caddy access logs

### Worker Node (default)
- Does not run Caddy
- Receives empty Caddy routes from control plane
- Skips all Caddy-related drift detection and reconciliation
- Lighter footprint, focused on running containers
