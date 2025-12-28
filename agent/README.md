# Techulus Cloud Agent

Agent that runs on worker servers and communicates with the control plane.

## Prerequisites

- WireGuard (`wg` and `wg-quick` commands)
- Podman
- Caddy (custom build with Cloudflare DNS module)
- dnsmasq

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

## Generating Proto Files

Install protobuf compiler and Go plugins:

```bash
brew install protobuf protoc-gen-go protoc-gen-go-grpc
```

Generate Go code from proto definitions (run from repository root):

```bash
protoc --go_out=agent/internal/proto --go_opt=paths=source_relative \
       --go-grpc_out=agent/internal/proto --go-grpc_opt=paths=source_relative \
       proto/agent.proto
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
sudo ./agent --url <control-plane-url> --grpc-url <grpc-server>:50051 --token <registration-token> --data-dir /var/lib/techulus-agent
```

### Subsequent Runs

```bash
sudo ./agent --url <control-plane-url> --grpc-url <grpc-server>:50051 --data-dir /var/lib/techulus-agent
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
ExecStart=/usr/local/bin/agent --url <control-plane-url> --grpc-url <grpc-server>:50051 --data-dir /var/lib/techulus-agent
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
| `--grpc-url` | | gRPC server URL (e.g., `100.65.138.73:50051`) |
| `--grpc-tls` | `false` | Use TLS for gRPC connection |

## Behavior

- Agent connects to the control plane via gRPC bidirectional streaming
- Status updates are sent every 10 seconds, heartbeats every 30 seconds
- Work items are received in real-time over the persistent stream
- Automatic reconnection with exponential backoff (1s to 5min max)
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
