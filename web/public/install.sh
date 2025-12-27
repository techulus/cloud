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
if [ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
fi
if [ ! -f /etc/apt/sources.list.d/caddy-stable.list ]; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
fi
apt-get install -y caddy

echo "==> Installing dnsmasq..."
apt-get install -y dnsmasq

echo "==> Configuring Caddy..."
systemctl stop caddy || true
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile << 'EOF'
{
  admin localhost:2019
}
EOF
systemctl enable caddy

echo "==> Configuring dnsmasq..."
systemctl stop dnsmasq || true

echo "==> Enabling IP forwarding..."
echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-wireguard.conf
sysctl -p /etc/sysctl.d/99-wireguard.conf

echo "==> Dependencies installed successfully!"
echo ""
echo "Next steps:"
echo "  1. Download the agent binary"
echo "  2. Run: ./agent --url <control-plane-url> --grpc-url <grpc-url> --token <token>"
