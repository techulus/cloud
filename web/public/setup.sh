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
  printf -v "$var_name" '%s' "$value"
}

pkg_update() {
  if [ "$OS_FAMILY" = "debian" ]; then
    apt-get update -qq
  else
    dnf check-update || true
  fi
}

pkg_install() {
  if [ "$OS_FAMILY" = "debian" ]; then
    apt-get install -y "$@"
  else
    dnf install -y "$@"
  fi
}

pkg_hold() {
  if [ "$OS_FAMILY" = "debian" ]; then
    apt-mark hold "$@" 2>/dev/null || true
  else
    dnf versionlock add "$@" 2>/dev/null || true
  fi
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
echo "  ETCD_ENDPOINT      (required for proxy nodes, e.g., 'http://etcd.example.com:2379')"
echo "  ACME_EMAIL         (required for proxy nodes)"
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

OS_FAMILY=""
if [[ "$ID" == "debian" || "$ID" == "ubuntu" || "$ID_LIKE" == *"debian"* ]]; then
  OS_FAMILY="debian"
elif [[ "$ID" == "rhel" || "$ID" == "fedora" || "$ID" == "oracle" || "$ID" == "rocky" || "$ID" == "almalinux" || "$ID" == "centos" || "$ID_LIKE" == *"rhel"* || "$ID_LIKE" == *"fedora"* ]]; then
  OS_FAMILY="rhel"
else
  error "Unsupported distribution: $ID. Supported: Debian, Ubuntu, RHEL, Oracle Linux, Fedora, Rocky, AlmaLinux, CentOS"
fi
echo "✓ Detected $PRETTY_NAME ($OS_FAMILY family)"

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

if [ "$IS_PROXY" = "true" ]; then
  prompt ETCD_ENDPOINT "Enter etcd endpoint (e.g., http://etcd.example.com:2379): " required
  if [ -z "$ETCD_ENDPOINT" ]; then
    error "etcd endpoint is required for proxy nodes"
  fi
  if [[ ! "$ETCD_ENDPOINT" =~ ^https?:// ]]; then
    ETCD_ENDPOINT="http://${ETCD_ENDPOINT}"
  fi
  echo "✓ etcd Endpoint: $ETCD_ENDPOINT"

  prompt ACME_EMAIL "Enter email for Let's Encrypt certificates: " required
  if [ -z "$ACME_EMAIL" ]; then
    error "ACME email is required for proxy nodes"
  fi
  echo "✓ ACME Email: $ACME_EMAIL"
fi

step "Verifying connectivity..."

HEALTH_URL="${CONTROL_PLANE_URL}/api/health"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" != "200" ]; then
  error "Cannot reach control plane at $HEALTH_URL (HTTP status: $HTTP_STATUS). Please check the URL and your network connection."
fi
echo "✓ Control plane is reachable"

if [ -n "$LOGS_ENDPOINT" ]; then
  if ! curl -s -o /dev/null --connect-timeout 10 "$LOGS_ENDPOINT" 2>/dev/null; then
    error "Cannot reach logs endpoint at $LOGS_ENDPOINT. Please check the URL and your network connection."
  fi
  echo "✓ Logs endpoint is reachable"
fi

if [ "$IS_PROXY" = "true" ] && [ -n "$ETCD_ENDPOINT" ]; then
  ETCD_URL_NO_SCHEME="${ETCD_ENDPOINT#http://}"
  ETCD_URL_NO_SCHEME="${ETCD_URL_NO_SCHEME#https://}"
  ETCD_HOST=$(echo "$ETCD_URL_NO_SCHEME" | cut -d: -f1)
  ETCD_PORT=$(echo "$ETCD_URL_NO_SCHEME" | cut -d: -f2)
  if [ -z "$ETCD_PORT" ] || [ "$ETCD_PORT" = "$ETCD_HOST" ]; then
    ETCD_PORT="2379"
  fi
  if command -v nc &>/dev/null; then
    if ! nc -z -w5 "$ETCD_HOST" "$ETCD_PORT" 2>/dev/null; then
      error "Cannot reach etcd at $ETCD_ENDPOINT. Traefik requires etcd for certificate storage. Please ensure etcd is running and accessible."
    fi
  else
    if ! timeout 5 bash -c "echo >/dev/tcp/$ETCD_HOST/$ETCD_PORT" 2>/dev/null; then
      error "Cannot reach etcd at $ETCD_ENDPOINT. Traefik requires etcd for certificate storage. Please ensure etcd is running and accessible."
    fi
  fi
  echo "✓ etcd endpoint is reachable"
fi

echo ""
echo "Configuration summary:"
echo "  Control Plane URL: $CONTROL_PLANE_URL"
echo "  Proxy Mode:        $IS_PROXY"
if [ "$IS_PROXY" = "true" ]; then
  echo "  etcd Endpoint:     $ETCD_ENDPOINT"
  echo "  ACME Email:        $ACME_EMAIL"
fi
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
pkg_hold sudo sudo-rs
pkg_update
echo "✓ Package lists updated"

step "Installing git..."
if command -v git &>/dev/null; then
  echo "git already installed, skipping"
else
  pkg_install git
fi
if ! git --version &>/dev/null; then
  error "Failed to install git"
fi
echo "✓ git verified"

step "Installing WireGuard..."
if command -v wg &>/dev/null; then
  echo "WireGuard already installed, skipping"
else
  if [ "$OS_FAMILY" = "debian" ]; then
    pkg_install wireguard wireguard-tools
  else
    pkg_install wireguard-tools
  fi
fi
if ! wg --version &>/dev/null; then
  error "Failed to install WireGuard"
fi
echo "✓ WireGuard verified"

step "Installing Podman..."
if command -v podman &>/dev/null; then
  echo "Podman already installed, skipping"
else
  pkg_install podman
fi
if ! podman --version &>/dev/null; then
  error "Failed to install Podman"
fi
echo "✓ Podman verified"

if [ "$IS_PROXY" = "true" ]; then
  step "Installing Traefik (proxy mode)..."
  TRAEFIK_VERSION="v3.2.3"
  if [ -x /usr/local/bin/traefik ]; then
    echo "Traefik already installed, skipping"
  else
    curl -fsSL "https://github.com/traefik/traefik/releases/download/${TRAEFIK_VERSION}/traefik_${TRAEFIK_VERSION}_linux_${AGENT_ARCH}.tar.gz" -o /tmp/traefik.tar.gz
    if [ ! -f /tmp/traefik.tar.gz ]; then
      error "Failed to download Traefik"
    fi
    tar -xzf /tmp/traefik.tar.gz -C /usr/local/bin traefik
    rm /tmp/traefik.tar.gz
    chmod +x /usr/local/bin/traefik
    if command -v chcon &>/dev/null; then
      chcon -t bin_t /usr/local/bin/traefik 2>/dev/null || true
    fi
  fi
  if ! /usr/local/bin/traefik version &>/dev/null; then
    error "Failed to install Traefik"
  fi
  echo "✓ Traefik verified"
else
  echo "Skipping Traefik installation (worker node)"
fi

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
if [ -x /usr/local/bin/railpack ]; then
  echo "Railpack already installed, skipping"
else
  curl -fsSL https://railpack.com/install.sh | bash
fi
if ! /usr/local/bin/railpack --version &>/dev/null; then
  error "Failed to install Railpack"
fi
echo "✓ Railpack verified"

step "Installing crane (for multi-arch manifests)..."
CRANE_VERSION="v0.20.7"
CRANE_ARCH=$ARCH
if [ "$ARCH" = "aarch64" ]; then
  CRANE_ARCH="arm64"
fi
if [ -x /usr/local/bin/crane ]; then
  echo "crane already installed, skipping"
else
  curl -fsSL "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_${CRANE_ARCH}.tar.gz" -o /tmp/crane.tar.gz
  if [ ! -f /tmp/crane.tar.gz ]; then
    error "Failed to download crane"
  fi
  tar -xzf /tmp/crane.tar.gz -C /usr/local/bin crane
  rm /tmp/crane.tar.gz
  chmod +x /usr/local/bin/crane
fi
if ! /usr/local/bin/crane version &>/dev/null; then
  error "Failed to install crane"
fi
echo "✓ crane installed"

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
if command -v chcon &>/dev/null; then
  chcon -t bin_t /usr/local/bin/techulus-agent 2>/dev/null || true
fi

if ! /usr/local/bin/techulus-agent --help &>/dev/null; then
  error "Agent binary is not executable or corrupted"
fi
echo "✓ Agent binary verified"

if [ "$IS_PROXY" = "true" ]; then
  step "Configuring Traefik..."

  mkdir -p /etc/traefik/dynamic
  mkdir -p /var/log/traefik
  chmod 755 /var/log/traefik
  touch /var/log/traefik/access.log
  chmod 644 /var/log/traefik/access.log
  if command -v chcon &>/dev/null; then
    chcon -R -t httpd_log_t /var/log/traefik 2>/dev/null || true
  fi
  echo "✓ Traefik directories created"

  cat > /etc/traefik/environment << EOF
ETCD_ENDPOINT=${ETCD_ENDPOINT}
ACME_EMAIL=${ACME_EMAIL}
EOF
  chmod 600 /etc/traefik/environment
  echo "✓ Traefik environment file created"

  cat > /etc/traefik/traefik.yaml << 'EOF'
global:
  checkNewVersion: false
  sendAnonymousUsage: false

log:
  level: INFO
  format: json

accessLog:
  filePath: /var/log/traefik/access.log
  format: json
  fields:
    defaultMode: keep
    headers:
      defaultMode: drop

api:
  dashboard: false
  insecure: false

entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
          permanent: true
  websecure:
    address: ":443"
    http:
      tls:
        certResolver: letsencrypt

providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true

certificatesResolvers:
  letsencrypt:
    acme:
      email: "${ACME_EMAIL}"
      storage: "etcd"
      caServer: "https://acme-v02.api.letsencrypt.org/directory"
      httpChallenge:
        entryPoint: web

etcd:
  endpoints:
    - "${ETCD_ENDPOINT}"
  rootKey: "traefik"
EOF
  if [ ! -f /etc/traefik/traefik.yaml ]; then
    error "Failed to create Traefik config"
  fi
  echo "✓ Traefik config created"

  cat > /etc/systemd/system/traefik.service << 'EOF'
[Unit]
Description=Traefik Reverse Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/traefik/environment
ExecStart=/usr/local/bin/traefik --configFile=/etc/traefik/traefik.yaml
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
  if [ ! -f /etc/systemd/system/traefik.service ]; then
    error "Failed to create Traefik service file"
  fi
  echo "✓ Traefik systemd service created"

  step "Configuring firewall for proxy node..."
  if [ "$OS_FAMILY" = "rhel" ] && systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port=80/tcp 2>/dev/null || true
    firewall-cmd --permanent --add-port=443/tcp 2>/dev/null || true
    firewall-cmd --permanent --add-port=51820/udp 2>/dev/null || true
    firewall-cmd --reload 2>/dev/null || true
    echo "✓ firewalld rules added (HTTP, HTTPS, WireGuard)"
  elif command -v iptables &>/dev/null; then
    iptables -I INPUT -p tcp --dport 80 -m state --state NEW -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p tcp --dport 443 -m state --state NEW -j ACCEPT 2>/dev/null || true
    iptables -I INPUT -p udp --dport 51820 -j ACCEPT 2>/dev/null || true
    echo "✓ iptables rules added (HTTP, HTTPS, WireGuard)"

    if command -v netfilter-persistent &>/dev/null; then
      netfilter-persistent save 2>/dev/null || true
      echo "✓ iptables rules persisted"
    elif [ "$OS_FAMILY" = "debian" ]; then
      pkg_install iptables-persistent -y 2>/dev/null || true
      netfilter-persistent save 2>/dev/null || true
      echo "✓ iptables-persistent installed and rules saved"
    fi
  fi
fi

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
  AFTER_SERVICES="network-online.target traefik.service buildkitd.service"
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
KillMode=process
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
  systemctl enable traefik
  systemctl restart traefik
  sleep 2
  if ! systemctl is-active --quiet traefik; then
    error "Failed to start Traefik"
  fi
  echo "✓ Traefik started"
fi

systemctl enable techulus-agent
systemctl restart techulus-agent
sleep 3
if ! systemctl is-active --quiet techulus-agent; then
  journalctl -u techulus-agent --no-pager -n 20
  error "Failed to start agent"
fi
echo "✓ Agent started"

step "Final verification..."

if [ "$IS_PROXY" = "true" ]; then
  SERVICES=("traefik" "techulus-agent" "buildkitd")
else
  SERVICES=("techulus-agent" "buildkitd")
fi

for svc in "${SERVICES[@]}"; do
  if ! systemctl is-active --quiet "$svc"; then
    error "Service $svc is not running"
  fi
  echo "✓ $svc is running"
done

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
  echo "  View Traefik logs:  journalctl -u traefik -f"
fi
echo "  Agent status:       systemctl status techulus-agent"
echo "  Restart agent:      systemctl restart techulus-agent"
echo ""
