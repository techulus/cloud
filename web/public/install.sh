#!/bin/bash
set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root"
  exit 1
fi

echo "==> Installing Techulus Cloud agent dependencies..."

apt-get update

echo "==> Installing WireGuard..."
apt-get install -y wireguard wireguard-tools

echo "==> Installing Podman..."
apt-get install -y podman

echo "==> Installing Caddy..."
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

echo "==> Installing Go and building custom Caddy..."
apt-get install -y golang-go
export GOPATH=/root/go
export PATH=$PATH:$GOPATH/bin
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
systemctl stop caddy
xcaddy build --with github.com/caddy-dns/cloudflare --output /usr/bin/caddy

echo "==> Installing dnsmasq..."
apt-get install -y dnsmasq

echo "==> Configuring Caddy..."

cat > /etc/caddy/environment << 'EOF'
CF_API_TOKEN=
CONTROL_PLANE_URL=
EOF

mkdir -p /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/override.conf << 'EOF'
[Service]
EnvironmentFile=/etc/caddy/environment
EOF

cat > /etc/caddy/Caddyfile << 'EOF'
{
  admin localhost:2019
  on_demand_tls {
    ask {$CONTROL_PLANE_URL}/api/v1/caddy/check
  }
}

:80 {
  redir https://{host}{uri} permanent
}

:443 {
  tls {
    on_demand
    issuer acme {
      dns cloudflare {$CF_API_TOKEN}
    }
  }
  respond /__caddy_health__ "ok" 200
}
EOF

systemctl daemon-reload
systemctl enable caddy

echo "==> Configuring dnsmasq..."
systemctl stop dnsmasq || true

echo "==> Enabling IP forwarding..."
echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-wireguard.conf
sysctl -p /etc/sysctl.d/99-wireguard.conf

echo "==> Dependencies installed successfully!"
echo ""
echo "Next steps:"
echo "  1. Configure Caddy environment: sudo nano /etc/caddy/environment"
echo "     - Set CF_API_TOKEN (Cloudflare API token with Zone:DNS:Edit permission)"
echo "     - Set CONTROL_PLANE_URL (e.g., https://your-control-plane.com)"
echo "  2. Start Caddy: sudo systemctl start caddy"
echo "  3. Download the agent binary"
echo "  4. Run: ./agent --url <control-plane-url> --grpc-url <grpc-url> --token <token>"
