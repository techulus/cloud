# Proxy

Proxy nodes handle TLS termination and route public traffic to containers via the WireGuard mesh network.

## Architecture

```
User → DNS → Proxy Node(s) → TLS termination → WireGuard mesh → Container
```

- Only proxy nodes run Caddy and handle public traffic
- Worker nodes run containers but don't expose them directly
- Caddy uses HTTP-01 ACME challenge for automatic TLS certificates
- Routes are managed dynamically by the agent based on control plane state

## Caddy Configuration

Caddy uses on-demand TLS with HTTP-01 challenge for automatic certificates.

### Environment

```bash
sudo nano /etc/caddy/environment
```

```
CONTROL_PLANE_URL=https://your-control-plane.com
```

### Start Caddy

```bash
sudo systemctl start caddy
sudo journalctl -u caddy -f
```

## DNS Setup

Point your domain's DNS to the proxy node(s) public IP:

- **Single proxy**: A record pointing to proxy IP
- **Multiple proxies**: Multiple A records for DNS round-robin, or use a load balancer

## How It Works

1. User requests `app.example.com`
2. DNS resolves to proxy node IP
3. Caddy receives request, checks if it has a valid cert
4. If no cert, Caddy calls `/api/v1/caddy/check` to verify domain is allowed
5. Caddy obtains certificate via HTTP-01 ACME challenge
6. Agent adds route via Caddy admin API with container IPs as upstreams
7. Caddy reverse proxies to container via WireGuard mesh
