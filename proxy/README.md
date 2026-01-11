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

Point your domain's DNS to the proxy node(s) public IP:

- **Single proxy**: A record pointing to proxy IP
- **Multiple proxies**: Multiple A records for DNS round-robin, or use a load balancer

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
