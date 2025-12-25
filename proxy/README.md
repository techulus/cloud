# Proxy

The proxy is platform infrastructure that handles external traffic for all services. It terminates SSL, routes requests to backend containers via WireGuard mesh, and manages automatic HTTPS certificates. Unlike worker servers, the proxy runs no workloads—it's the only server with public ports exposed.

## Install Caddy

Follow: https://caddyserver.com/docs/install

## Install `dnsmasq`

dnsmasq provides DNS resolution for the `.internal` domain used by services within the WireGuard mesh network. It resolves `{service-name}.internal` to the WireGuard IP of the container running that service.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CONTROL_PLANE_URL` | Base URL for the control plane API (used for on-demand TLS validation) |

## Run

```bash
CONTROL_PLANE_URL=https://your-control-plane.com caddy run --config Caddyfile
```

## Agent Integration

The agent runs with `--proxy` flag to handle Caddy route synchronization:

```bash
./agent --url https://control-plane.com --proxy
```

**Flow:**
1. Control plane queues `sync_caddy` work items when services are deployed/updated
2. Agent polls and receives work with `action` (upsert/delete), `domain`, and `route`
3. Agent updates Caddy via Admin API (`localhost:2019`):
   - Adds/updates routes: `POST /config/apps/http/servers/srv0/routes`
   - Deletes routes: `DELETE /id/{domain}`
   - Persists config: `POST /config/persist`
