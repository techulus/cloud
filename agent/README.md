# Techulus Cloud Agent

Agent that runs on worker servers and communicates with the control plane.

## Prerequisites

- WireGuard (`wg` and `wg-quick` commands)
- Podman
- Caddy (custom build with Cloudflare DNS module)
- dnsmasq
- BuildKit + buildctl (for GitHub source builds)
- Railpack (for auto-detecting build configuration)

### Quick Install (Ubuntu)

```bash
curl -fsSL https://your-control-plane.com/install.sh | sudo bash
```

### Manual Ubuntu Setup

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install wireguard wireguard-tools podman dnsmasq golang-go -y

go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
xcaddy build --with github.com/caddy-dns/cloudflare --output /usr/bin/caddy

# Install Railpack
curl -sSL https://railpack.com/install.sh | sh
sudo ln -s ~/.railpack/bin/railpack /usr/local/bin/railpack

# Install buildctl
curl -sSL https://github.com/moby/buildkit/releases/download/v0.19.0/buildkit-v0.19.0.linux-amd64.tar.gz | sudo tar -xz -C /usr/local
```

## BuildKit Setup

BuildKit is required for building container images from GitHub sources. The agent uses `buildctl` to build and push images directly to the registry.

### Configure BuildKit for Insecure Registry

Create a config file to allow pushing to HTTP registries:

```bash
sudo mkdir -p /etc/buildkit
sudo tee /etc/buildkit/buildkitd.toml << 'EOF'
[registry."your-registry:5000"]
  http = true
EOF
```

Replace `your-registry:5000` with your actual registry address.

### Start BuildKit as a systemd Service

```bash
sudo nano /etc/systemd/system/buildkit.service
```

```ini
[Unit]
Description=BuildKit Container
After=network.target

[Service]
Type=simple
ExecStartPre=-/usr/bin/podman rm -f buildkit
ExecStart=/usr/bin/podman run --rm --privileged --name buildkit -p 127.0.0.1:1234:1234 -v /etc/buildkit/buildkitd.toml:/etc/buildkit/buildkitd.toml docker.io/moby/buildkit --addr tcp://0.0.0.0:1234
ExecStop=/usr/bin/podman stop buildkit
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable buildkit
sudo systemctl start buildkit
```

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

## Build

```bash
go build -o bin/agent ./cmd/agent

# Cross-compile for Linux
GOOS=linux GOARCH=amd64 go build -o bin/agent-linux-amd64 ./cmd/agent
```

## Usage

### First Run (Registration)

```bash
sudo ./agent --url <control-plane-url> --token <registration-token> --data-dir /var/lib/techulus-agent
```

### Subsequent Runs

```bash
sudo ./agent --url <control-plane-url> --data-dir /var/lib/techulus-agent
```

### Run as systemd Service

```bash
sudo nano /etc/systemd/system/techulus-agent.service
```

```ini
[Unit]
Description=Techulus Cloud Agent
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/agent --url <control-plane-url> --data-dir /var/lib/techulus-agent --logs-endpoint http://athena:9428
Environment=BUILDKIT_HOST=tcp://127.0.0.1:1234
Restart=always
RestartSec=5
KillMode=process

[Install]
WantedBy=multi-user.target
```

**Important:** `KillMode=process` ensures only the agent process is killed on restart, not the container processes (conmon) which are children of the agent.

```bash
sudo systemctl daemon-reload
sudo systemctl enable techulus-agent
sudo systemctl start techulus-agent
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | (required) | Control plane URL |
| `--token` | | Registration token (required for first run) |
| `--data-dir` | `/var/lib/techulus-agent` | Data directory for agent state |
| `--logs-endpoint` | | VictoriaLogs endpoint for log collection (e.g., `http://athena:9428`) |

## State Machine

The agent uses a two-state machine for reconciliation:

```
┌─────────┐                         ┌────────────┐
│  IDLE   │───drift detected───────▶│ PROCESSING │
│ (poll)  │◀────────────────────────│  (no poll) │
└─────────┘    done/failed/timeout  └────────────┘
```

### IDLE State
- Polls control plane every 10 seconds for expected state
- Compares expected vs actual state
- If drift detected: transitions to PROCESSING

### PROCESSING State
- Uses snapshot of expected state (no re-polling)
- Applies ONE change at a time:
  1. Stop orphan containers (no deployment ID)
  2. Start containers in "created" or "exited" state
  3. Deploy missing containers
  4. Redeploy containers with wrong image
  5. Update DNS records
  6. Update Caddy routes
  7. Update WireGuard peers
- Timeout: 5 minutes max
- Always reports status before returning to IDLE

### Drift Detection

Uses hash comparisons for deterministic drift detection:
- Containers: Missing, orphaned, wrong state, or image mismatch
- DNS: Hash of sorted records
- Caddy: Hash of sorted routes
- WireGuard: Hash of sorted peers

## Container Labels

The agent tracks containers using Podman labels:

| Label | Description |
|-------|-------------|
| `techulus.deployment.id` | Links container to deployment record |
| `techulus.service.id` | Links container to service |
| `techulus.service.name` | Human-readable service name |

Containers with a `techulus.deployment.id` label are managed by the agent. Containers without this label are considered orphans and will be cleaned up.

## Data Directory Structure

```
/var/lib/techulus-agent/
├── config.json       # Server ID and WireGuard IP
├── keys/
│   ├── private.key   # Ed25519 signing key
│   └── public.key    # Ed25519 public key
└── wireguard.key     # WireGuard private key
```

## Troubleshooting

### Agent restart kills containers

If containers are killed when the agent restarts, ensure `KillMode=process` is set in the systemd service file. Without this, systemd kills all child processes (including conmon container managers).

### Containers in "created" state after restart

This is normal - the agent will automatically start these containers. Look for logs like:
```
[reconcile] starting created container <id> for deployment <deployment-id>
```

### IP allocation errors

If you see "IPAM error: requested ip address is already allocated", this usually means a container in "created" state still has the IP allocated. The agent should handle this by starting the existing container instead of creating a new one.

### Checking agent status

```bash
sudo journalctl -u techulus-agent -f
```

### Manual container inspection

```bash
podman ps -a --format "table {{.Names}}\t{{.State}}\t{{.Labels}}"
```
