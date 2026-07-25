# Proxy

Proxy nodes handle TLS termination and route public traffic to containers via the WireGuard mesh network.

## Architecture

```
User → DNS → Proxy Node(s) → TLS termination → WireGuard mesh → Container
```

- Only proxy nodes run Traefik and handle public traffic
- Worker nodes run containers but don't expose them directly
- Traefik uses HTTP-01 ACME challenge for automatic TLS certificates via Let's Encrypt
- Routes are managed dynamically by the agent via file provider

## Traefik Configuration

Traefik is configured with:
- Static config: `/etc/traefik/traefik.yaml`
- Dynamic routes: `/etc/traefik/dynamic/routes.yaml` (managed by agent)
- ACME storage: `/etc/traefik/acme.json`

### Environment

```bash
sudo cat /etc/traefik/environment
```

```
ACME_EMAIL=you@example.com
```

### Start Traefik

```bash
sudo systemctl start traefik
sudo journalctl -u traefik -f
```

### Dashboard (optional)

To enable the dashboard, edit `/etc/traefik/traefik.yaml`:

```yaml
api:
  dashboard: true
  insecure: true  # exposes on :8080
```

Access at `http://<proxy-ip>:8080/dashboard/`

## DNS Setup

Point your domain at a stable edge address:

- **Production**: use a stable external load balancer with active health checks,
  and configure every proxy public IP as an origin
- **Single proxy**: an A record can point directly to the proxy, but there is no
  ingress failover
- **Multiple A records**: provide best-effort distribution, not reliable failover;
  clients may cache and continue using an offline proxy
- **Health-aware GeoDNS**: supported as an alternative, with failover still
  subject to DNS and client caching

A stable external load balancer with active health checks is the ideal production
solution for proxy failure. Workload rebalancing updates proxy routes; it does not
modify public DNS or remove failed proxies from external traffic.

## How It Works

1. User requests `app.example.com`
2. DNS resolves to proxy node IP
3. Traefik receives request on port 443
4. If no cert exists, Traefik obtains one via HTTP-01 ACME challenge
5. Agent writes route to `/etc/traefik/dynamic/routes.yaml`
6. Traefik reverse proxies to container via WireGuard mesh

## Route Format

The agent generates routes in this format:

```yaml
http:
  routers:
    svc_abc123:
      rule: "Host(`app.example.com`)"
      entryPoints:
        - websecure
      service: svc_abc123
      tls:
        certResolver: letsencrypt

  services:
    svc_abc123:
      loadBalancer:
        servers:
          - url: "http://10.200.1.5:3000"
          - url: "http://10.200.1.6:3000"
```

## Logs

Access logs are written to `/var/log/traefik/access.log` in JSON format and collected by the agent.

View logs:
```bash
sudo journalctl -u traefik -f
sudo tail -f /var/log/traefik/access.log | jq
```
