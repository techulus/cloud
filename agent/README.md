# Techulus Cloud Agent

Agent that runs on worker servers and communicates with the control plane.

See [docs/AGENT.md](../docs/AGENT.md) for architecture details.

## Prerequisites

- WireGuard (`wg` and `wg-quick` commands)
- Podman
- Caddy (with cloudflare DNS plugin)
- dnsmasq
- BuildKit + buildctl
- Railpack

### Manual Ubuntu Setup

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install wireguard wireguard-tools podman dnsmasq golang-go -y

go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
xcaddy build --with github.com/caddy-dns/cloudflare --output /usr/bin/caddy

curl -sSL https://railpack.com/install.sh | sh
sudo ln -s ~/.railpack/bin/railpack /usr/local/bin/railpack

curl -sSL https://github.com/moby/buildkit/releases/download/v0.26.3/buildkit-v0.26.3.linux-amd64.tar.gz | sudo tar -xz -C /usr/local
```

This installs both `buildkitd` (daemon) and `buildctl` (CLI) to `/usr/local/bin/`.

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
