//go:build linux

package paths

const (
	DataDir        = "/var/lib/techulus-agent"
	BuildKitSocket = "unix:///run/buildkit/buildkitd.sock"
	WireGuardDir   = "/etc/wireguard"
	DnsmasqDir     = "/etc/dnsmasq.d"
	DnsmasqConf    = "/etc/dnsmasq.conf"
	ResolvedDir    = "/etc/systemd/resolved.conf.d"
)
