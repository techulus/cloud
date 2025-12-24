# Techulus Cloud Agent

Agent that runs on worker servers and communicates with the control plane.

## Prerequisites

- WireGuard (`wg` and `wg-quick` commands)
- Podman

### Ubuntu Setup

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install wireguard wireguard-tools -y
sudo apt install podman -y
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
ExecStart=/usr/local/bin/agent --url <control-plane-url> --data-dir /var/lib/techulus-agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

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
| `--poll-interval` | `10s` | Poll interval for status updates |

## Behavior

- Agent polls the control plane every 10 seconds (configurable)
- After 30 consecutive failed requests, the agent shuts down
- On success, the failure counter resets to 0
- Containers bind to WireGuard IP only (not exposed on public interface)

## Data Directory Structure

```
/var/lib/techulus-agent/
├── config.json       # Server ID and WireGuard IP
├── keys/
│   ├── private.key   # Ed25519 signing key
│   └── public.key    # Ed25519 public key
└── wireguard.key     # WireGuard private key
```
