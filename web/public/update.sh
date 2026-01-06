#!/bin/bash
set -e

error() {
  echo ""
  echo "ERROR: $1" >&2
  exit 1
}

echo ""
echo "=========================================="
echo "  Techulus Cloud Agent Updater"
echo "=========================================="
echo ""

if [ "$(id -u)" -ne 0 ]; then
  error "This script must be run as root"
fi

if [ ! -f /usr/local/bin/techulus-agent ]; then
  error "Agent not installed. Run setup.sh first."
fi

ARCH=$(uname -m)
case $ARCH in
  x86_64)
    AGENT_ARCH="amd64"
    ;;
  aarch64)
    AGENT_ARCH="arm64"
    ;;
  *)
    error "Unsupported architecture: $ARCH"
    ;;
esac
echo "Architecture: $ARCH ($AGENT_ARCH)"

echo "Downloading latest agent..."
AGENT_URL="https://github.com/techulus/cloud/releases/download/tip/agent-linux-${AGENT_ARCH}"
CHECKSUM_URL="https://github.com/techulus/cloud/releases/download/tip/checksums.txt"

curl -fsSL -o /tmp/techulus-agent "$AGENT_URL"
if [ ! -f /tmp/techulus-agent ]; then
  error "Failed to download agent binary"
fi

curl -fsSL -o /tmp/checksums.txt "$CHECKSUM_URL"
if [ ! -f /tmp/checksums.txt ]; then
  rm -f /tmp/techulus-agent
  error "Failed to download checksums file"
fi

EXPECTED_CHECKSUM=$(grep "agent-linux-${AGENT_ARCH}" /tmp/checksums.txt | awk '{print $1}')
if [ -z "$EXPECTED_CHECKSUM" ]; then
  rm -f /tmp/techulus-agent /tmp/checksums.txt
  error "Could not find checksum for agent-linux-${AGENT_ARCH}"
fi

ACTUAL_CHECKSUM=$(sha256sum /tmp/techulus-agent | awk '{print $1}')
if [ "$EXPECTED_CHECKSUM" != "$ACTUAL_CHECKSUM" ]; then
  rm -f /tmp/techulus-agent /tmp/checksums.txt
  error "Checksum verification failed"
fi
echo "✓ Checksum verified"
rm -f /tmp/checksums.txt

chmod +x /tmp/techulus-agent
mv /tmp/techulus-agent /usr/local/bin/techulus-agent

echo "Restarting agent..."
systemctl restart techulus-agent
sleep 3

if ! systemctl is-active --quiet techulus-agent; then
  journalctl -u techulus-agent --no-pager -n 20
  error "Failed to start agent"
fi

echo ""
echo "=========================================="
echo "  Update completed successfully!"
echo "=========================================="
echo ""
echo "Agent status: $(systemctl is-active techulus-agent)"
echo ""
