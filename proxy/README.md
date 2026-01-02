# Proxy

## Caddy Configuration

Caddy uses DNS-01 challenge via Cloudflare for automatic TLS certificates. This allows multiple servers behind DNS round-robin to independently obtain certificates.

### Create Cloudflare API Token

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Create token with permissions: `Zone → DNS → Edit`
3. Select zone resources: your domain(s)

### Configure Environment

```bash
sudo nano /etc/caddy/environment
```

```
CF_API_TOKEN=your-cloudflare-api-token
CONTROL_PLANE_URL=https://your-control-plane.com
```

### Start Caddy

```bash
sudo systemctl start caddy
sudo journalctl -u caddy -f
```
