# macOS Setup Guide

On macOS, containers run inside OrbStack/Docker which has isolated networking. Additional setup is required for WireGuard traffic to reach containers.

## Prerequisites

- OrbStack or Docker Desktop
- WireGuard (`brew install wireguard-tools`)
- BuildKit client (`brew install buildkit`)

## Enable IP Forwarding

```bash
sudo sysctl -w net.inet.ip.forwarding=1
```

To persist across reboots:
```bash
echo "net.inet.ip.forwarding=1" | sudo tee -a /etc/sysctl.conf
```

## NAT Setup for Container Traffic

Containers only respond to IPs on their local subnet. Traffic from other servers via WireGuard needs NAT.

**1. Create NAT rule file:**

Replace `X` with your subnet ID (check your WireGuard IP - if it's 10.100.5.1, your subnet ID is 5):

```bash
echo 'nat on bridge101 from 10.100.0.0/16 to 10.200.X.0/24 -> (bridge101)' | sudo tee /etc/pf.anchors/wireguard-nat
```

**2. Backup pf.conf:**

```bash
sudo cp /etc/pf.conf /etc/pf.conf.backup
```

**3. Add anchor to pf.conf:**

```bash
sudo nano /etc/pf.conf
```

Add these lines near the top (after existing `nat-anchor` lines):

```
nat-anchor "wireguard-nat"
load anchor "wireguard-nat" from "/etc/pf.anchors/wireguard-nat"
```

**4. Load the config:**

```bash
sudo pfctl -f /etc/pf.conf
```

**5. Verify:**

```bash
sudo pfctl -a wireguard-nat -s nat
```

## BuildKit Setup

On macOS, BuildKit daemon (buildkitd) must run inside a Linux VM or container. The Homebrew formula only includes the client tools.

**Using OrbStack/Docker (recommended):**

```bash
docker run -d --name buildkitd --privileged moby/buildkit:latest
```

Then run the agent with the `BUILDKIT_HOST` env var. Use `sudo -E` to preserve environment variables:

```bash
sudo BUILDKIT_HOST=docker-container://buildkitd ./agent --url <control-plane-url> --data-dir /var/lib/techulus-agent
```

Or with `-E`:

```bash
BUILDKIT_HOST=docker-container://buildkitd sudo -E ./agent --url <control-plane-url> --data-dir /var/lib/techulus-agent
```

## Insecure Registry (HTTP)

If you see errors like:
```
Error response from daemon: Get "https://registry:5000/v2/": http: server gave HTTP response to HTTPS client
```

Docker is trying to use HTTPS for a registry that only supports HTTP. Configure OrbStack to allow insecure registries:

1. Open OrbStack → Settings → Docker
2. Add `registry:5000` (or your registry address) to "Insecure registries"
3. Restart Docker from the OrbStack menu bar

Alternatively, edit `~/.orbstack/config/docker.json`:
```json
{
  "insecure-registries": ["registry:5000"]
}
```

## WireGuard Commands

```bash
sudo wg show
wg-quick down wg0 && wg-quick up wg0
```

## Debugging Network Issues

Check if packets arrive on WireGuard interface:
```bash
sudo tcpdump -i utun5 icmp -n
```

Check if packets reach Docker bridge:
```bash
sudo tcpdump -i bridge101 icmp -n
```

Test connectivity:
```bash
# Ping from Mac to container
ping -c 3 10.200.5.3

# Check IP forwarding is enabled
sysctl net.inet.ip.forwarding

# Verify NAT rule
sudo pfctl -a wireguard-nat -s nat
```
