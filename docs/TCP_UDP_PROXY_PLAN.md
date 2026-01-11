# TCP/UDP (L4) Proxy Support Implementation Plan

## Summary
Add TCP and UDP proxy support to complement the existing HTTP proxy. Users can expose database servers (PostgreSQL, MySQL, Redis) and custom TCP/UDP services via user-specified ports with TLS passthrough for TCP.

## Architecture Overview

```
Current (HTTP only):        After (HTTP + TCP/UDP):

Internet                    Internet
   │                           │
   ▼                           ▼
Traefik :80/:443            Traefik :80/:443 + :10000-10099 (TCP) + :11000-11099 (UDP)
   │                           │
   ▼                           ▼
WireGuard mesh → Container   WireGuard mesh → Container
```

## Key Challenge: Entry Point Limitation

Traefik requires entry points (ports) to be defined in static configuration - dynamic entry points are NOT supported.

**Solution**: Pre-allocate port ranges in static config:
- TCP: ports 10000-10099 (100 ports)
- UDP: ports 11000-11099 (100 ports)

## Implementation Steps

### Step 1: Database Schema Changes

**File**: `web/db/schema.ts`

Modify `servicePorts` table:
```typescript
export const servicePorts = pgTable("service_ports", {
  id: text("id").primaryKey(),
  serviceId: text("service_id")
    .notNull()
    .references(() => services.id, { onDelete: "cascade" }),
  port: integer("port").notNull(),
  isPublic: boolean("is_public").notNull().default(false),
  domain: text("domain").unique(),
  // NEW FIELDS:
  protocol: text("protocol", { enum: ["http", "tcp", "udp"] })
    .notNull()
    .default("http"),
  externalPort: integer("external_port"), // The public port (10001, 11005, etc.)
  tlsPassthrough: boolean("tls_passthrough").notNull().default(false),
  sniHostname: text("sni_hostname"), // For SNI-based TCP routing
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
```

Add new table for port allocation tracking:
```typescript
export const allocatedPorts = pgTable("allocated_ports", {
  id: text("id").primaryKey(),
  port: integer("port").notNull().unique(),
  protocol: text("protocol", { enum: ["tcp", "udp"] }).notNull(),
  servicePortId: text("service_port_id")
    .references(() => servicePorts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
```

Generate Drizzle migration after schema changes.

### Step 2: Traefik Static Configuration

**File**: `proxy/traefik.yaml`

Add TCP/UDP entry points (append after existing entry points):
```yaml
entryPoints:
  # ... existing web and websecure ...

  # TCP ports (10000-10099)
  tcp-10000:
    address: ":10000"
  tcp-10001:
    address: ":10001"
  # ... through tcp-10099

  # UDP ports (11000-11099)
  udp-11000:
    address: ":11000/udp"
  udp-11001:
    address: ":11001/udp"
  # ... through udp-11099
```

Consider creating a script to generate this file or use a templating approach.

### Step 3: Port Allocation Service

**File**: `web/lib/port-allocation.ts` (new file)

```typescript
const TCP_PORT_START = 10000;
const TCP_PORT_END = 10099;
const UDP_PORT_START = 11000;
const UDP_PORT_END = 11099;

export async function allocateTCPPort(): Promise<number>
export async function allocateUDPPort(): Promise<number>
export async function releasePort(servicePortId: string): Promise<void>
```

### Step 4: Agent Traefik Package Updates

**File**: `agent/internal/traefik/traefik.go`

Add new types:
```go
type TraefikTCPRoute struct {
    ID             string
    ServiceId      string
    Upstreams      []string // Format: "ip:port" (no http:// prefix)
    ExternalPort   int
    TLSPassthrough bool
    SNIHostname    string
}

type TraefikUDPRoute struct {
    ID           string
    ServiceId    string
    Upstreams    []string
    ExternalPort int
}
```

Update config structure to include TCP/UDP sections:
```go
type traefikFullConfig struct {
    HTTP httpConfig `yaml:"http,omitempty"`
    TCP  tcpConfig  `yaml:"tcp,omitempty"`
    UDP  udpConfig  `yaml:"udp,omitempty"`
}
```

New function signature:
```go
func UpdateTraefikRoutesWithL4(
    httpRoutes []TraefikRoute,
    tcpRoutes []TraefikTCPRoute,
    udpRoutes []TraefikUDPRoute,
) error
```

TCP route generation example:
```yaml
tcp:
  routers:
    tcp_svc123:
      rule: "HostSNI(`db.example.com`)"  # or "HostSNI(`*`)" for non-TLS
      entryPoints: ["tcp-10001"]
      service: tcp_svc123
      tls:
        passthrough: true
  services:
    tcp_svc123:
      loadBalancer:
        servers:
          - address: "10.200.1.5:5432"
```

Add hash functions: `HashTCPRoutes()`, `HashUDPRoutes()`, `GetCurrentTCPConfigHash()`, `GetCurrentUDPConfigHash()`

### Step 5: Agent HTTP Client Types

**File**: `agent/internal/http/client.go`

Update ExpectedState structure:
```go
type ExpectedState struct {
    // ... existing fields ...
    Traefik struct {
        Routes    []TraefikRoute    `json:"routes"`     // HTTP
        TCPRoutes []TraefikTCPRoute `json:"tcpRoutes"`
        UDPRoutes []TraefikUDPRoute `json:"udpRoutes"`
    } `json:"traefik"`
}
```

### Step 6: Control Plane Expected State API

**File**: `web/app/api/v1/agent/expected-state/route.ts`

Add TCP/UDP route generation logic for proxy nodes:
- Query servicePorts with protocol = 'tcp' or 'udp'
- Build route objects with external port, upstreams, TLS settings
- Include in response alongside HTTP routes

### Step 7: Agent Reconciliation Loop

**File**: `agent/cmd/agent/main.go`

Update `detectChanges()` to check TCP/UDP config hashes.

Update `reconcileOne()` to call `UpdateTraefikRoutesWithL4()` when drift detected.

### Step 8: Service Configuration Actions

**File**: `web/actions/projects.ts`

Update port handling to:
- Accept protocol type (http/tcp/udp)
- Allocate external port for TCP/UDP services
- Store TLS passthrough and SNI hostname settings

### Step 9: UI Updates (optional, can be deferred)

Files:
- `web/components/service-canvas.tsx`
- `web/components/create-service-dialog.tsx`

Add:
- Protocol dropdown (HTTP/TCP/UDP)
- TLS passthrough toggle for TCP
- SNI hostname input field
- Display allocated external port

## Critical Files to Modify

| File | Changes |
|------|---------|
| `web/db/schema.ts` | Add protocol, externalPort, tlsPassthrough, sniHostname to servicePorts; add allocatedPorts table |
| `proxy/traefik.yaml` | Add 100 TCP + 100 UDP entry points |
| `web/lib/port-allocation.ts` | New file for port allocation logic |
| `agent/internal/traefik/traefik.go` | Add TCP/UDP types, config generation, hash functions |
| `agent/internal/http/client.go` | Add TCPRoutes, UDPRoutes to ExpectedState |
| `web/app/api/v1/agent/expected-state/route.ts` | Generate TCP/UDP routes for proxy nodes |
| `agent/cmd/agent/main.go` | Add TCP/UDP drift detection and reconciliation |
| `web/actions/projects.ts` | Handle TCP/UDP port creation with allocation |

## Verification Plan

### Unit Tests
1. Port allocation returns unique ports within range
2. Traefik config generation produces valid YAML for TCP/UDP
3. Hash functions are deterministic

### Integration Tests
1. Create service with TCP port → verify route appears in Traefik config
2. Delete service → verify port is released
3. Multiple services with different protocols coexist

### Manual Testing
```bash
# PostgreSQL TCP test
psql -h proxy.example.com -p 10001 -U postgres

# MySQL TCP test
mysql -h proxy.example.com -P 10002 -u root

# TLS passthrough verification
openssl s_client -connect proxy.example.com:10003 -servername db.myapp.com
```

## Implementation Order

1. Database schema + migration
2. Port allocation service
3. Traefik static config (requires proxy server update)
4. Agent traefik package
5. Agent HTTP client types
6. Expected state API
7. Agent reconciliation
8. Service actions
9. UI (optional)

## Notes

- Traefik static config change requires restarting Traefik on proxy nodes
- Port allocation is first-come-first-served; consider adding user port preferences later
- UDP services don't support TLS (no SNI)
- For TLS passthrough, the backend service must handle TLS certificates
