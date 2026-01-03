# Techulus Cloud Agent

Agent that runs on worker servers and communicates with the control plane.

See [docs/AGENT.md](../docs/AGENT.md) for architecture details.

## Node Types

The agent supports two modes:

- **Worker Node** (default): Runs containers only, no public traffic handling
- **Proxy Node** (`--proxy`): Handles TLS termination and routes public traffic to containers via WireGuard mesh

## Prerequisites

### All Nodes
- WireGuard (`wg` and `wg-quick` commands)
- Podman
- dnsmasq
- BuildKit + buildctl
- Railpack

### Proxy Nodes Only
- Caddy

## Automated Installation

Use the install script for automated setup:

```bash
curl -sSL https://your-control-plane.com/install.sh | sudo bash
```

The script will ask if this is a proxy node and configure accordingly.

For non-interactive installation:

```bash
export CONTROL_PLANE_URL=https://your-control-plane.com
export REGISTRATION_TOKEN=your-token
export IS_PROXY=true  # or false for worker nodes
curl -sSL $CONTROL_PLANE_URL/install.sh | sudo bash
```

## Manual Setup

### Worker Node

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install wireguard wireguard-tools podman dnsmasq -y

curl -sSL https://railpack.com/install.sh | sh
sudo ln -s ~/.railpack/bin/railpack /usr/local/bin/railpack

curl -sSL https://github.com/moby/buildkit/releases/download/v0.26.3/buildkit-v0.26.3.linux-amd64.tar.gz | sudo tar -xz -C /usr/local
```

### Proxy Node

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install wireguard wireguard-tools podman dnsmasq caddy -y

curl -sSL https://railpack.com/install.sh | sh
sudo ln -s ~/.railpack/bin/railpack /usr/local/bin/railpack

curl -sSL https://github.com/moby/buildkit/releases/download/v0.26.3/buildkit-v0.26.3.linux-amd64.tar.gz | sudo tar -xz -C /usr/local
```

## BuildKit Setup

```bash
sudo nano /etc/systemd/system/buildkit.service
```

```ini
[Unit]
Description=BuildKit Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/buildkitd
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

## Build

```bash
go build -o bin/agent ./cmd/agent

GOOS=linux GOARCH=amd64 go build -o bin/agent-linux-amd64 ./cmd/agent
```

## Usage

### First Run (Registration)

Worker node:
```bash
sudo ./agent --url <control-plane-url> --token <registration-token> --data-dir /var/lib/techulus-agent
```

Proxy node:
```bash
sudo ./agent --url <control-plane-url> --token <registration-token> --data-dir /var/lib/techulus-agent --proxy
```

### Subsequent Runs

Worker node:
```bash
sudo ./agent --url <control-plane-url> --data-dir /var/lib/techulus-agent
```

Proxy node:
```bash
sudo ./agent --url <control-plane-url> --data-dir /var/lib/techulus-agent --proxy
```

### Run as systemd Service

```bash
sudo nano /etc/systemd/system/techulus-agent.service
```

Worker node:
```ini
[Unit]
Description=Techulus Cloud Agent
After=network.target buildkitd.service

[Service]
Type=simple
ExecStart=/usr/local/bin/agent --url <control-plane-url> --data-dir /var/lib/techulus-agent
Restart=always
RestartSec=5
KillMode=process

[Install]
WantedBy=multi-user.target
```

Proxy node:
```ini
[Unit]
Description=Techulus Cloud Agent
After=network.target caddy.service buildkitd.service

[Service]
Type=simple
ExecStart=/usr/local/bin/agent --url <control-plane-url> --data-dir /var/lib/techulus-agent --proxy
Restart=always
RestartSec=5
KillMode=process

[Install]
WantedBy=multi-user.target
```

`KillMode=process` ensures only the agent process is killed on restart, not container processes.

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
| `--logs-endpoint` | | VictoriaLogs endpoint (e.g., `http://athena:9428`) |
| `--proxy` | `false` | Run as proxy node (handles TLS and public traffic) |

## Troubleshooting

### Agent restart kills containers

Ensure `KillMode=process` is set in the systemd service file.

### Containers in "created" state after restart

Normal - the agent will automatically start these containers.

### Checking agent status

```bash
sudo journalctl -u techulus-agent -f
```

### Manual container inspection

```bash
podman ps -a --format "table {{.Names}}\t{{.State}}\t{{.Labels}}"
```
