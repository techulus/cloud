#!/bin/bash
set -e

STEP_NUM=0

error() {
  echo ""
  echo "ERROR: $1" >&2
  exit 1
}

step() {
  STEP_NUM=$((STEP_NUM + 1))
  echo ""
  echo "==> [$STEP_NUM] $1"
}

prompt() {
  local var_name="$1"
  local prompt_text="$2"
  local required="$3"
  local current_value="${!var_name}"

  if [ -n "$current_value" ]; then
    echo "Using $var_name from environment: ${current_value:0:20}..."
    return 0
  fi

  if [ ! -t 0 ]; then
    if [ "$required" = "required" ]; then
      error "$var_name is required. Set it as an environment variable for non-interactive mode."
    fi
    return 0
  fi

  read -p "$prompt_text" value
  eval "$var_name=\"\$value\""
}

echo ""
echo "=========================================="
echo "  Techulus Cloud Agent Installer"
echo "=========================================="
echo ""
echo "This software comes with ABSOLUTELY NO WARRANTY,"
echo "to the extent permitted by applicable law."
echo ""
echo "This is ALPHA software - use at your own risk."
echo ""
echo "=========================================="
echo ""
echo "For non-interactive installation, set these environment variables:"
echo "  CONTROL_PLANE_URL  (required)"
echo "  REGISTRATION_TOKEN (required for new installs)"
echo "  IS_PROXY           (set to 'true' for proxy nodes)"
echo "  LOGS_ENDPOINT      (optional)"
echo ""

step "Checking prerequisites..."

if [ "$(id -u)" -ne 0 ]; then
  error "This script must be run as root"
fi
echo "✓ Running as root"

if [ ! -f /etc/os-release ]; then
  error "Cannot detect OS - /etc/os-release not found"
fi

. /etc/os-release
if [[ "$ID" != "debian" && "$ID" != "ubuntu" && "$ID_LIKE" != *"debian"* ]]; then
  error "This script requires a Debian-based distribution (Debian, Ubuntu, etc.)"
fi
echo "✓ Detected $PRETTY_NAME"

ARCH=$(uname -m)
case $ARCH in
  x86_64)
    AGENT_ARCH="amd64"
    BUILDKIT_ARCH="amd64"
    ;;
  aarch64)
    AGENT_ARCH="arm64"
    BUILDKIT_ARCH="arm64"
    ;;
  *)
    error "Unsupported architecture: $ARCH"
    ;;
esac
echo "✓ Architecture: $ARCH ($AGENT_ARCH)"

step "Collecting configuration..."

prompt CONTROL_PLANE_URL "Enter Control Plane URL (e.g., https://api.example.com): " required
if [[ ! "$CONTROL_PLANE_URL" =~ ^https:// ]]; then
  error "Control Plane URL must start with https://"
fi
echo "✓ Control Plane URL: $CONTROL_PLANE_URL"

if [ -f /var/lib/techulus-agent/config.json ]; then
  echo "✓ Existing agent installation detected, skipping registration token"
  NEW_SETUP=false
  IS_PROXY=$(grep -o '"isProxy":[^,}]*' /var/lib/techulus-agent/config.json 2>/dev/null | grep -o 'true\|false' || echo "false")
  echo "✓ Proxy mode: $IS_PROXY (from existing config)"
else
  echo "New installation detected"
  prompt REGISTRATION_TOKEN "Enter registration token: " required
  if [ -z "$REGISTRATION_TOKEN" ]; then
    error "Registration token is required for new installations"
  fi
  NEW_SETUP=true
  echo "✓ Registration token provided"

  if [ -z "$IS_PROXY" ]; then
    if [ -t 0 ]; then
      read -p "Is this a proxy node? (handles public traffic/TLS) [y/N] " PROXY_ANSWER
      if [[ "$PROXY_ANSWER" =~ ^[Yy]$ ]]; then
        IS_PROXY=true
      else
        IS_PROXY=false
      fi
    else
      IS_PROXY=false
    fi
  fi
  echo "✓ Proxy mode: $IS_PROXY"
fi

prompt LOGS_ENDPOINT "Enter Logs Endpoint (optional, press Enter to skip): " optional
if [ -n "$LOGS_ENDPOINT" ]; then
  echo "✓ Logs Endpoint: $LOGS_ENDPOINT"
else
  echo "✓ Logs Endpoint: (disabled)"
fi

echo ""
echo "Configuration summary:"
echo "  Control Plane URL: $CONTROL_PLANE_URL"
echo "  Proxy Mode:        $IS_PROXY"
echo "  Logs Endpoint:     ${LOGS_ENDPOINT:-disabled}"
echo "  New Setup:         $NEW_SETUP"
echo ""

if [ -t 0 ]; then
  read -p "Continue with installation? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Installation cancelled."
    exit 0
  fi
fi

step "Updating package lists..."
apt-get update -qq
echo "✓ Package lists updated"

step "Installing git..."
if command -v git &>/dev/null; then
  echo "git already installed, skipping"
else
  apt-get install -y git
fi
if ! git --version &>/dev/null; then
  error "Failed to install git"
fi
echo "✓ git verified"

step "Installing WireGuard..."
if command -v wg &>/dev/null; then
  echo "WireGuard already installed, skipping"
else
  apt-get install -y wireguard wireguard-tools
fi
if ! wg --version &>/dev/null; then
  error "Failed to install WireGuard"
fi
echo "✓ WireGuard verified"

step "Installing Podman..."
if command -v podman &>/dev/null; then
  echo "Podman already installed, skipping"
else
  apt-get install -y podman
fi
if ! podman --version &>/dev/null; then
  error "Failed to install Podman"
fi
echo "✓ Podman verified"

if [ "$IS_PROXY" = "true" ]; then
  step "Installing Caddy (proxy mode)..."
  if command -v caddy &>/dev/null; then
    echo "Caddy already installed, skipping"
  else
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    chmod o+r /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y caddy
  fi
  if ! caddy version &>/dev/null; then
    error "Failed to install Caddy"
  fi
  echo "✓ Caddy verified"
else
  echo "Skipping Caddy installation (worker node)"
fi

step "Installing dnsmasq..."
if command -v dnsmasq &>/dev/null; then
  echo "dnsmasq already installed, skipping"
else
  apt-get install -y dnsmasq
fi
if ! dnsmasq --version &>/dev/null; then
  error "Failed to install dnsmasq"
fi
echo "✓ dnsmasq verified"

step "Installing BuildKit..."
BUILDKIT_VERSION="v0.21.0"
if command -v buildkitd &>/dev/null; then
  echo "BuildKit already installed, skipping"
else
  curl -fsSL "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-${BUILDKIT_ARCH}.tar.gz" -o /tmp/buildkit.tar.gz
  if [ ! -f /tmp/buildkit.tar.gz ]; then
    error "Failed to download BuildKit"
  fi
  tar -xzf /tmp/buildkit.tar.gz -C /usr/local
  rm /tmp/buildkit.tar.gz
fi
if ! /usr/local/bin/buildkitd --version &>/dev/null; then
  error "Failed to install BuildKit"
fi
echo "✓ BuildKit installed"

step "Installing Railpack..."
if command -v railpack &>/dev/null; then
  echo "Railpack already installed, skipping"
else
  curl -fsSL https://railpack.com/install.sh | bash
fi
if ! railpack --version &>/dev/null; then
  error "Failed to install Railpack"
fi
echo "✓ Railpack verified"

step "Downloading Techulus Cloud agent..."
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
  error "Could not find checksum for agent-linux-${AGENT_ARCH} in checksums.txt"
fi

ACTUAL_CHECKSUM=$(sha256sum /tmp/techulus-agent | awk '{print $1}')
if [ "$EXPECTED_CHECKSUM" != "$ACTUAL_CHECKSUM" ]; then
  rm -f /tmp/techulus-agent /tmp/checksums.txt
  error "Checksum verification failed. Expected: $EXPECTED_CHECKSUM, Got: $ACTUAL_CHECKSUM"
fi
echo "✓ Checksum verified"

rm -f /tmp/checksums.txt
mv /tmp/techulus-agent /usr/local/bin/techulus-agent
chmod +x /usr/local/bin/techulus-agent

if ! /usr/local/bin/techulus-agent --help &>/dev/null; then
  error "Agent binary is not executable or corrupted"
fi
echo "✓ Agent binary verified"

if [ "$IS_PROXY" = "true" ]; then
  step "Configuring Caddy..."

  cat > /etc/caddy/environment << EOF
CONTROL_PLANE_URL=${CONTROL_PLANE_URL}
EOF
  if [ ! -f /etc/caddy/environment ]; then
    error "Failed to create /etc/caddy/environment"
  fi
  chmod 600 /etc/caddy/environment
  echo "✓ Caddy environment file created"

  mkdir -p /etc/systemd/system/caddy.service.d
  cat > /etc/systemd/system/caddy.service.d/override.conf << 'EOF'
[Service]
EnvironmentFile=/etc/caddy/environment
EOF
  if [ ! -f /etc/systemd/system/caddy.service.d/override.conf ]; then
    error "Failed to create Caddy systemd override"
  fi
  echo "✓ Caddy systemd override created"

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
  }

  log {
    output file /var/log/caddy/techulus.log {
      roll_size 50mb
      roll_keep 3
    }
    format json
  }

  respond /__caddy_health__ "ok" 200
}
EOF
  if [ ! -f /etc/caddy/Caddyfile ]; then
    error "Failed to create Caddyfile"
  fi
  echo "✓ Caddyfile created"

  export CONTROL_PLANE_URL="$CONTROL_PLANE_URL"
  caddy validate --config /etc/caddy/Caddyfile
  if [ $? -ne 0 ]; then
    error "Caddyfile validation failed"
  fi
  echo "✓ Caddyfile validated"
fi

step "Preparing dnsmasq..."
mkdir -p /etc/dnsmasq.d
systemctl stop dnsmasq 2>/dev/null || true
echo "✓ dnsmasq installed (agent will configure and start it)"

step "Enabling IP forwarding..."
echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-wireguard.conf
sysctl -p /etc/sysctl.d/99-wireguard.conf

FORWARDING=$(cat /proc/sys/net/ipv4/ip_forward)
if [ "$FORWARDING" != "1" ]; then
  error "Failed to enable IP forwarding"
fi
echo "✓ IP forwarding enabled"

step "Creating agent data directory..."
mkdir -p /var/lib/techulus-agent

if [ ! -d /var/lib/techulus-agent ]; then
  error "Failed to create /var/lib/techulus-agent"
fi
echo "✓ Data directory created"

step "Creating BuildKit systemd service..."
cat > /etc/systemd/system/buildkitd.service << 'EOF'
[Unit]
Description=BuildKit Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/buildkitd
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
if [ ! -f /etc/systemd/system/buildkitd.service ]; then
  error "Failed to create BuildKit service file"
fi

systemctl daemon-reload
systemctl enable buildkitd
systemctl start buildkitd
sleep 2
if ! systemctl is-active --quiet buildkitd; then
  error "Failed to start BuildKit daemon"
fi
echo "✓ BuildKit daemon running"

step "Creating agent configuration..."

cat > /var/lib/techulus-agent/environment << EOF
AGENT_URL=${CONTROL_PLANE_URL}
AGENT_DATA_DIR=/var/lib/techulus-agent
AGENT_LOGS_ENDPOINT=${LOGS_ENDPOINT}
EOF
chmod 600 /var/lib/techulus-agent/environment

if [ ! -f /var/lib/techulus-agent/environment ]; then
  error "Failed to create agent environment file"
fi
echo "✓ Agent environment file created"

step "Creating agent systemd service..."

LOGS_ARG=""
if [ -n "$LOGS_ENDPOINT" ]; then
  LOGS_ARG="--logs-endpoint \${AGENT_LOGS_ENDPOINT}"
fi

PROXY_ARG=""
if [ "$IS_PROXY" = "true" ]; then
  PROXY_ARG="--proxy"
fi

if [ "$IS_PROXY" = "true" ]; then
  AFTER_SERVICES="network-online.target caddy.service buildkitd.service"
else
  AFTER_SERVICES="network-online.target buildkitd.service"
fi

cat > /etc/systemd/system/techulus-agent.service << EOF
[Unit]
Description=Techulus Cloud Agent
After=${AFTER_SERVICES}
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/var/lib/techulus-agent/environment
ExecStart=/usr/local/bin/techulus-agent --url \${AGENT_URL} --data-dir \${AGENT_DATA_DIR} ${LOGS_ARG} ${PROXY_ARG}
Restart=always
RestartSec=10
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
EOF

if [ ! -f /etc/systemd/system/techulus-agent.service ]; then
  error "Failed to create agent service file"
fi

systemctl daemon-reload
echo "✓ Agent service file created"

if [ "$NEW_SETUP" = true ]; then
  step "Registering agent with control plane..."
  echo "(Note: Registration token is one-time use and invalidated after registration)"

  REGISTER_PROXY_ARG=""
  if [ "$IS_PROXY" = "true" ]; then
    REGISTER_PROXY_ARG="--proxy"
  fi

  /usr/local/bin/techulus-agent --url "$CONTROL_PLANE_URL" --token "$REGISTRATION_TOKEN" --data-dir /var/lib/techulus-agent $REGISTER_PROXY_ARG &
  AGENT_PID=$!

  REGISTERED=false
  SECONDS=0
  while [ $SECONDS -lt 60 ]; do
    if [ -f /var/lib/techulus-agent/config.json ]; then
      REGISTERED=true
      break
    fi
    if ! kill -0 $AGENT_PID 2>/dev/null; then
      break
    fi
    sleep 2
  done

  kill $AGENT_PID 2>/dev/null || true
  wait $AGENT_PID 2>/dev/null || true

  if [ "$REGISTERED" != true ]; then
    error "Agent registration failed - config.json not created within 60 seconds"
  fi
  echo "✓ Agent registered successfully"
else
  echo "Existing registration found, skipping registration step"
fi

step "Starting services..."

systemctl daemon-reload

if [ "$IS_PROXY" = "true" ]; then
  systemctl enable caddy
  systemctl restart caddy
  sleep 2
  if ! systemctl is-active --quiet caddy; then
    error "Failed to start Caddy"
  fi
  echo "✓ Caddy started"
fi

systemctl enable techulus-agent
systemctl start techulus-agent
sleep 3
if ! systemctl is-active --quiet techulus-agent; then
  journalctl -u techulus-agent --no-pager -n 20
  error "Failed to start agent"
fi
echo "✓ Agent started"

step "Final verification..."

if [ "$IS_PROXY" = "true" ]; then
  SERVICES=("caddy" "techulus-agent" "buildkitd")
else
  SERVICES=("techulus-agent" "buildkitd")
fi

for svc in "${SERVICES[@]}"; do
  if ! systemctl is-active --quiet "$svc"; then
    error "Service $svc is not running"
  fi
  echo "✓ $svc is running"
done
echo "✓ dnsmasq will be configured by agent"

echo ""
echo "=========================================="
echo "  Installation completed successfully!"
echo "=========================================="
echo ""
if [ "$IS_PROXY" = "true" ]; then
  echo "Node type: PROXY (handles public traffic/TLS)"
else
  echo "Node type: WORKER (containers only)"
fi
echo ""
echo "All services are running:"
for svc in "${SERVICES[@]}"; do
  STATUS=$(systemctl is-active "$svc")
  echo "  - $svc: $STATUS"
done
echo ""
echo "Useful commands:"
echo "  View agent logs:    journalctl -u techulus-agent -f"
if [ "$IS_PROXY" = "true" ]; then
  echo "  View Caddy logs:    journalctl -u caddy -f"
fi
echo "  Agent status:       systemctl status techulus-agent"
echo "  Restart agent:      systemctl restart techulus-agent"
echo ""
